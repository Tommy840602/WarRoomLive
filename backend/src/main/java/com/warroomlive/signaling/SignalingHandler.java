package com.warroomlive.signaling;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.warroomlive.chat.ChatRepository;
import com.warroomlive.chat.StoredMessage;
import com.warroomlive.events.OutboxRecorder;
import io.micrometer.core.instrument.MeterRegistry;
import io.micrometer.core.instrument.Timer;
import org.slf4j.Logger;
import org.springframework.beans.factory.ObjectProvider;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Component;
import org.springframework.web.socket.CloseStatus;
import org.springframework.web.socket.TextMessage;
import org.springframework.web.socket.WebSocketSession;
import org.springframework.web.socket.handler.ConcurrentWebSocketSessionDecorator;
import org.springframework.web.socket.handler.TextWebSocketHandler;

import java.io.IOException;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.atomic.AtomicInteger;

/**
 * WebSocket endpoint that relays WebRTC signaling between peers sharing a room.
 *
 * <p>The server never touches media; it only forwards SDP offers/answers and ICE
 * candidates to the addressed peer, and broadcasts membership changes. Peers form a
 * full mesh, so each pair negotiates directly.
 */
@Component
public class SignalingHandler extends TextWebSocketHandler {

    private static final Logger log = LoggerFactory.getLogger(SignalingHandler.class);

    /** Buffer/time limits before a slow client's session is force-closed by the decorator. */
    private static final int SEND_TIME_LIMIT_MS = 10_000;
    private static final int SEND_BUFFER_LIMIT_BYTES = 512 * 1024;

    private final RoomManager rooms;
    private final Backplane backplane;
    private final ObjectMapper mapper;
    private final ChatRepository chat;
    /** Present only under the kafka profile; membership events are skipped without it. */
    private final ObjectProvider<OutboxRecorder> outbox;
    private final int maxRoomSize;
    private final int historyLimit;

    /** Wraps raw sessions so concurrent sends from multiple peers are serialized safely. */
    private final Map<String, ConcurrentWebSocketSessionDecorator> safeSessions = new ConcurrentHashMap<>();

    private final MeterRegistry metrics;
    private final AtomicInteger connectionsActive = new AtomicInteger();
    private final Timer processingTimer;

    public SignalingHandler(
            RoomManager rooms,
            Backplane backplane,
            ObjectMapper mapper,
            ChatRepository chat,
            ObjectProvider<OutboxRecorder> outbox,
            MeterRegistry metrics,
            @org.springframework.beans.factory.annotation.Value("${warroomlive.signaling.max-room-size:8}") int maxRoomSize,
            @org.springframework.beans.factory.annotation.Value("${warroomlive.chat.history-limit:100}") int historyLimit) {
        this.rooms = rooms;
        this.backplane = backplane;
        this.mapper = mapper;
        this.chat = chat;
        this.outbox = outbox;
        this.metrics = metrics;
        this.maxRoomSize = maxRoomSize;
        this.historyLimit = historyLimit;
        metrics.gauge("warroomlive.signaling.connections.active", connectionsActive);
        this.processingTimer = Timer.builder("warroomlive.signaling.message.processing")
                .description("Time spent handling one inbound signaling message")
                .register(metrics);
        // Deliver backplane traffic from other nodes into this node's sessions.
        backplane.start(new Backplane.LocalDelivery() {
            @Override
            public void toPeer(String room, String peerId, SignalMessage message) {
                rooms.session(room, peerId).ifPresent(s -> send(s, message));
            }

            @Override
            public void toRoomExcept(String room, String excludePeerId, SignalMessage message) {
                rooms.othersIn(room, excludePeerId).forEach(s -> send(s, message));
            }
        });
    }

    @Override
    public void afterConnectionEstablished(WebSocketSession session) {
        safeSessions.put(session.getId(), new ConcurrentWebSocketSessionDecorator(
                session, SEND_TIME_LIMIT_MS, SEND_BUFFER_LIMIT_BYTES));
        connectionsActive.incrementAndGet();
        log.debug("WebSocket connected: {}", session.getId());
    }

    @Override
    protected void handleTextMessage(WebSocketSession session, TextMessage message) {
        processingTimer.record(() -> handleParsedMessage(session, message));
    }

    private void handleParsedMessage(WebSocketSession session, TextMessage message) {
        // Per-message credential check (oidc mode): a connection whose handshake
        // token has expired is closed — the client must reconnect with a renewed
        // token. 4401 mirrors HTTP 401 in the private close-code range.
        Object expiry = session.getAttributes().get(com.warroomlive.config.WebSocketConfig.TOKEN_EXPIRY_ATTRIBUTE);
        if (expiry instanceof Long expiresAtMillis && System.currentTimeMillis() > expiresAtMillis) {
            log.info("Closing session {}: handshake token expired", session.getId());
            countIn("token-expired");
            try {
                session.close(new CloseStatus(4401, "access token expired"));
            } catch (IOException e) {
                log.warn("Failed to close expired session {}: {}", session.getId(), e.getMessage());
            }
            return;
        }
        SignalMessage msg;
        try {
            msg = mapper.readValue(message.getPayload(), SignalMessage.class);
        } catch (Exception e) {
            log.warn("Dropping malformed signaling message from {}: {}", session.getId(), e.getMessage());
            countIn("malformed");
            sendError(session, null, "malformed message");
            return;
        }

        if (msg.type() == null) {
            countIn("malformed");
            sendError(session, null, "missing message type");
            return;
        }

        switch (msg.type()) {
            case SignalMessage.TYPE_JOIN -> handleJoin(session, msg);
            case SignalMessage.TYPE_OFFER, SignalMessage.TYPE_ANSWER, SignalMessage.TYPE_CANDIDATE ->
                    relayToPeer(session, msg);
            case SignalMessage.TYPE_CHAT -> handleChat(session, msg);
            case SignalMessage.TYPE_STATE, SignalMessage.TYPE_REACTION, SignalMessage.TYPE_HAND ->
                    broadcastToRoom(session, msg);
            case SignalMessage.TYPE_LEAVE -> handleLeave(session);
            default -> {
                countIn("unsupported");
                sendError(session, msg.room(), "unsupported message type: " + msg.type());
                return;
            }
        }
        countIn(msg.type());
    }

    /** The inbound type tag is bounded: known protocol types plus malformed/unsupported. */
    private void countIn(String type) {
        metrics.counter("warroomlive.signaling.messages.in", "type", type).increment();
    }

    private void handleJoin(WebSocketSession session, SignalMessage msg) {
        if (isBlank(msg.room()) || isBlank(msg.from())) {
            sendError(session, msg.room(), "join requires 'room' and 'from'");
            return;
        }

        // Read the (ghost-pruned) membership for the peers reply, then let the
        // backplane make the capacity decision atomically — reconnects of an
        // existing member always pass.
        List<PeerInfo> clusterPeers = backplane.peersIn(msg.room());
        String name = displayName(msg);
        if (!backplane.tryRegister(msg.room(), msg.from(), name, maxRoomSize)) {
            log.info("Rejected {} from full room {} (cap {})", msg.from(), msg.room(), maxRoomSize);
            send(session, new SignalMessage(
                    SignalMessage.TYPE_ROOM_FULL, msg.room(), null, msg.from(),
                    mapper.valueToTree(maxRoomSize)));
            return;
        }

        rooms.join(msg.room(), msg.from(), name, session);
        List<PeerInfo> existingPeers = clusterPeers.stream()
                .filter(info -> !info.id().equals(msg.from()))
                .toList();
        log.info("Peer {} ({}) joined room {} ({} existing peer(s))",
                msg.from(), name, msg.room(), existingPeers.size());

        // Tell the newcomer who is already here (id + name) so it can initiate offers.
        send(session, new SignalMessage(
                SignalMessage.TYPE_PEERS, msg.room(), null, msg.from(),
                mapper.valueToTree(existingPeers)));

        // Replay the room's recent chat so a refreshed or newly-joined peer has context.
        List<StoredMessage> history = chat.recent(msg.room(), historyLimit);
        if (!history.isEmpty()) {
            send(session, new SignalMessage(
                    SignalMessage.TYPE_HISTORY, msg.room(), null, msg.from(),
                    mapper.valueToTree(history)));
        }

        // Tell everyone else that a new peer arrived, carrying its display name.
        SignalMessage joined = new SignalMessage(
                SignalMessage.TYPE_PEER_JOINED, msg.room(), msg.from(), null,
                mapper.valueToTree(name));
        rooms.othersIn(msg.room(), msg.from()).forEach(other -> send(other, joined));
        backplane.publishToRoom(msg.room(), msg.from(), joined);
        outbox.ifAvailable(recorder -> recorder.record(
                "participant.joined", "room", msg.room(), Map.of("peerId", msg.from(), "name", name)));
    }

    private void relayToPeer(WebSocketSession session, SignalMessage msg) {
        if (isBlank(msg.room()) || isBlank(msg.to()) || isBlank(msg.from())) {
            sendError(session, msg.room(), msg.type() + " requires 'room', 'from' and 'to'");
            return;
        }
        Optional<WebSocketSession> target = rooms.session(msg.room(), msg.to());
        if (target.isPresent()) {
            send(target.get(), msg);
            return;
        }
        // Not on this node: route via the backplane if the directory knows the peer.
        if (backplane.nodeOf(msg.room(), msg.to()).isPresent()) {
            backplane.publishToPeer(msg.room(), msg.to(), msg);
            return;
        }
        sendError(session, msg.room(), "peer not found: " + msg.to());
    }

    /** Persists a chat message, then fans it out to everyone else in the room. */
    private void handleChat(WebSocketSession session, SignalMessage msg) {
        if (isBlank(msg.room()) || isBlank(msg.from()) || msg.payload() == null) {
            sendError(session, msg.room(), "chat requires 'room', 'from' and 'payload'");
            return;
        }
        String name = rooms.nameOf(msg.room(), msg.from()).orElse(msg.from());
        chat.append(msg.room(), new StoredMessage(
                msg.from(), name, msg.payload().asText(), System.currentTimeMillis()));
        rooms.othersIn(msg.room(), msg.from()).forEach(other -> send(other, msg));
        backplane.publishToRoom(msg.room(), msg.from(), msg);
    }

    /** Fans an ephemeral message (media state, reaction, hand) out to the rest of the room. */
    private void broadcastToRoom(WebSocketSession session, SignalMessage msg) {
        if (isBlank(msg.room()) || isBlank(msg.from()) || msg.payload() == null) {
            sendError(session, msg.room(), msg.type() + " requires 'room', 'from' and 'payload'");
            return;
        }
        rooms.othersIn(msg.room(), msg.from()).forEach(other -> send(other, msg));
        backplane.publishToRoom(msg.room(), msg.from(), msg);
    }

    private void handleLeave(WebSocketSession session) {
        rooms.remove(session).ifPresent(location -> broadcastPeerLeft(location));
    }

    @Override
    public void afterConnectionClosed(WebSocketSession session, CloseStatus status) {
        safeSessions.remove(session.getId());
        connectionsActive.decrementAndGet();
        rooms.remove(session).ifPresent(this::broadcastPeerLeft);
        log.debug("WebSocket closed: {} ({})", session.getId(), status);
    }

    private void broadcastPeerLeft(RoomManager.PeerLocation location) {
        log.info("Peer {} left room {}", location.peerId(), location.room());
        backplane.unregister(location.room(), location.peerId());
        SignalMessage left = new SignalMessage(
                SignalMessage.TYPE_PEER_LEFT, location.room(), location.peerId(), null, null);
        rooms.othersIn(location.room(), location.peerId()).forEach(other -> send(other, left));
        backplane.publishToRoom(location.room(), location.peerId(), left);
        outbox.ifAvailable(recorder -> recorder.record(
                "participant.left", "room", location.room(), Map.of("peerId", location.peerId())));
    }

    private void sendError(WebSocketSession session, String room, String reason) {
        send(session, new SignalMessage(
                SignalMessage.TYPE_ERROR, room, null, null, mapper.valueToTree(reason)));
    }

    private void send(WebSocketSession session, SignalMessage message) {
        WebSocketSession target = safeSessions.getOrDefault(session.getId(), null);
        WebSocketSession sink = target != null ? target : session;
        if (!sink.isOpen()) {
            return;
        }
        try {
            sink.sendMessage(new TextMessage(mapper.writeValueAsString(message)));
            metrics.counter("warroomlive.signaling.messages.out", "type", message.type()).increment();
        } catch (IOException e) {
            log.warn("Failed to send {} to {}: {}", message.type(), session.getId(), e.getMessage());
        }
    }

    /** Extracts a trimmed display name from a join payload, falling back to the peer id. */
    private static String displayName(SignalMessage msg) {
        if (msg.payload() != null && msg.payload().isTextual()) {
            String name = msg.payload().asText().trim();
            if (!name.isEmpty()) {
                return name;
            }
        }
        return msg.from();
    }

    private static boolean isBlank(String s) {
        return s == null || s.isBlank();
    }
}
