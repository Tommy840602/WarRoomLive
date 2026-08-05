package com.warroomlive.signaling;

import com.fasterxml.jackson.databind.ObjectMapper;
import org.slf4j.Logger;
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
    private final ObjectMapper mapper;
    private final int maxRoomSize;

    /** Wraps raw sessions so concurrent sends from multiple peers are serialized safely. */
    private final Map<String, ConcurrentWebSocketSessionDecorator> safeSessions = new ConcurrentHashMap<>();

    public SignalingHandler(
            RoomManager rooms,
            ObjectMapper mapper,
            @org.springframework.beans.factory.annotation.Value("${warroomlive.signaling.max-room-size:8}") int maxRoomSize) {
        this.rooms = rooms;
        this.mapper = mapper;
        this.maxRoomSize = maxRoomSize;
    }

    @Override
    public void afterConnectionEstablished(WebSocketSession session) {
        safeSessions.put(session.getId(), new ConcurrentWebSocketSessionDecorator(
                session, SEND_TIME_LIMIT_MS, SEND_BUFFER_LIMIT_BYTES));
        log.debug("WebSocket connected: {}", session.getId());
    }

    @Override
    protected void handleTextMessage(WebSocketSession session, TextMessage message) {
        SignalMessage msg;
        try {
            msg = mapper.readValue(message.getPayload(), SignalMessage.class);
        } catch (Exception e) {
            log.warn("Dropping malformed signaling message from {}: {}", session.getId(), e.getMessage());
            sendError(session, null, "malformed message");
            return;
        }

        if (msg.type() == null) {
            sendError(session, null, "missing message type");
            return;
        }

        switch (msg.type()) {
            case SignalMessage.TYPE_JOIN -> handleJoin(session, msg);
            case SignalMessage.TYPE_OFFER, SignalMessage.TYPE_ANSWER, SignalMessage.TYPE_CANDIDATE ->
                    relayToPeer(session, msg);
            case SignalMessage.TYPE_CHAT, SignalMessage.TYPE_STATE,
                 SignalMessage.TYPE_REACTION, SignalMessage.TYPE_HAND -> broadcastToRoom(session, msg);
            case SignalMessage.TYPE_LEAVE -> handleLeave(session);
            default -> sendError(session, msg.room(), "unsupported message type: " + msg.type());
        }
    }

    private void handleJoin(WebSocketSession session, SignalMessage msg) {
        if (isBlank(msg.room()) || isBlank(msg.from())) {
            sendError(session, msg.room(), "join requires 'room' and 'from'");
            return;
        }

        // Reject if the room is at capacity — unless this peer is already a member (reconnect).
        List<String> current = rooms.peersIn(msg.room()).stream().map(PeerInfo::id).toList();
        if (current.size() >= maxRoomSize && !current.contains(msg.from())) {
            log.info("Rejected {} from full room {} ({}/{})",
                    msg.from(), msg.room(), current.size(), maxRoomSize);
            send(session, new SignalMessage(
                    SignalMessage.TYPE_ROOM_FULL, msg.room(), null, msg.from(),
                    mapper.valueToTree(maxRoomSize)));
            return;
        }

        String name = displayName(msg);
        List<PeerInfo> existingPeers = rooms.join(msg.room(), msg.from(), name, session);
        log.info("Peer {} ({}) joined room {} ({} existing peer(s))",
                msg.from(), name, msg.room(), existingPeers.size());

        // Tell the newcomer who is already here (id + name) so it can initiate offers.
        send(session, new SignalMessage(
                SignalMessage.TYPE_PEERS, msg.room(), null, msg.from(),
                mapper.valueToTree(existingPeers)));

        // Tell everyone else that a new peer arrived, carrying its display name.
        SignalMessage joined = new SignalMessage(
                SignalMessage.TYPE_PEER_JOINED, msg.room(), msg.from(), null,
                mapper.valueToTree(name));
        rooms.othersIn(msg.room(), msg.from()).forEach(other -> send(other, joined));
    }

    private void relayToPeer(WebSocketSession session, SignalMessage msg) {
        if (isBlank(msg.room()) || isBlank(msg.to()) || isBlank(msg.from())) {
            sendError(session, msg.room(), msg.type() + " requires 'room', 'from' and 'to'");
            return;
        }
        Optional<WebSocketSession> target = rooms.session(msg.room(), msg.to());
        if (target.isEmpty()) {
            sendError(session, msg.room(), "peer not found: " + msg.to());
            return;
        }
        send(target.get(), msg);
    }

    /** Fans a message (chat text or media state) out to everyone else in the room. */
    private void broadcastToRoom(WebSocketSession session, SignalMessage msg) {
        if (isBlank(msg.room()) || isBlank(msg.from()) || msg.payload() == null) {
            sendError(session, msg.room(), msg.type() + " requires 'room', 'from' and 'payload'");
            return;
        }
        rooms.othersIn(msg.room(), msg.from()).forEach(other -> send(other, msg));
    }

    private void handleLeave(WebSocketSession session) {
        rooms.remove(session).ifPresent(location -> broadcastPeerLeft(location));
    }

    @Override
    public void afterConnectionClosed(WebSocketSession session, CloseStatus status) {
        safeSessions.remove(session.getId());
        rooms.remove(session).ifPresent(this::broadcastPeerLeft);
        log.debug("WebSocket closed: {} ({})", session.getId(), status);
    }

    private void broadcastPeerLeft(RoomManager.PeerLocation location) {
        log.info("Peer {} left room {}", location.peerId(), location.room());
        SignalMessage left = new SignalMessage(
                SignalMessage.TYPE_PEER_LEFT, location.room(), location.peerId(), null, null);
        rooms.othersIn(location.room(), location.peerId()).forEach(other -> send(other, left));
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
