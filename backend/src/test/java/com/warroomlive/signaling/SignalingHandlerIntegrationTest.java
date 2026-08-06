package com.warroomlive.signaling;

import com.fasterxml.jackson.core.type.TypeReference;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.warroomlive.chat.StoredMessage;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.web.server.LocalServerPort;
import org.springframework.web.socket.CloseStatus;
import org.springframework.web.socket.TextMessage;
import org.springframework.web.socket.WebSocketHttpHeaders;
import org.springframework.web.socket.WebSocketSession;
import org.springframework.web.socket.client.standard.StandardWebSocketClient;
import org.springframework.web.socket.handler.TextWebSocketHandler;

import java.net.URI;
import java.util.List;
import java.util.concurrent.BlockingQueue;
import java.util.concurrent.LinkedBlockingQueue;
import java.util.concurrent.TimeUnit;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * Drives the real {@code /ws/signal} endpoint with two WebSocket clients and verifies
 * peer discovery on join and peer-to-peer relay of an offer.
 */
@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT)
class SignalingHandlerIntegrationTest {

    @LocalServerPort
    private int port;

    @Autowired
    private ObjectMapper mapper;

    private URI signalUri() {
        return URI.create("ws://localhost:" + port + "/ws/signal");
    }

    @Test
    void joinReturnsExistingPeersAndNotifiesOthers() throws Exception {
        StandardWebSocketClient client = new StandardWebSocketClient();

        // Alice joins an empty room.
        RecordingHandler alice = new RecordingHandler();
        WebSocketSession aliceSession = client
                .execute(alice, new WebSocketHttpHeaders(), signalUri()).get(5, TimeUnit.SECONDS);
        aliceSession.sendMessage(text(new SignalMessage(
                "join", "room-1", "alice", null, mapper.valueToTree("Alice"))));

        SignalMessage alicePeers = alice.take();
        assertThat(alicePeers.type()).isEqualTo("peers");
        assertThat(mapper.convertValue(alicePeers.payload(), List.class)).isEmpty();

        // Opening the room makes Alice the host; the meta state follows the peers list.
        SignalMessage aliceState = alice.take();
        assertThat(aliceState.type()).isEqualTo("room-state");
        assertThat(aliceState.payload().get("host").asText()).isEqualTo("alice");
        assertThat(aliceState.payload().get("locked").asBoolean()).isFalse();

        // Bob joins the same room.
        RecordingHandler bob = new RecordingHandler();
        WebSocketSession bobSession = client
                .execute(bob, new WebSocketHttpHeaders(), signalUri()).get(5, TimeUnit.SECONDS);
        bobSession.sendMessage(text(new SignalMessage(
                "join", "room-1", "bob", null, mapper.valueToTree("Bob"))));

        // Bob sees Alice already present, with her display name.
        SignalMessage bobPeers = bob.take();
        assertThat(bobPeers.type()).isEqualTo("peers");
        List<PeerInfo> peers = mapper.convertValue(
                bobPeers.payload(), new TypeReference<List<PeerInfo>>() {});
        assertThat(peers).containsExactly(new PeerInfo("alice", "Alice"));
        assertThat(bob.take().type()).isEqualTo("room-state");

        // Alice is notified that Bob arrived, carrying his name.
        SignalMessage aliceNotice = alice.take();
        assertThat(aliceNotice.type()).isEqualTo("peer-joined");
        assertThat(aliceNotice.from()).isEqualTo("bob");
        assertThat(mapper.convertValue(aliceNotice.payload(), String.class)).isEqualTo("Bob");

        // Alice sends Bob an offer; it is relayed verbatim.
        aliceSession.sendMessage(text(new SignalMessage(
                "offer", "room-1", "alice", "bob", mapper.valueToTree("sdp-blob"))));
        SignalMessage relayed = bob.take();
        assertThat(relayed.type()).isEqualTo("offer");
        assertThat(relayed.from()).isEqualTo("alice");
        assertThat(mapper.convertValue(relayed.payload(), String.class)).isEqualTo("sdp-blob");

        // Chat from Alice is broadcast to Bob (but not echoed back to Alice).
        aliceSession.sendMessage(text(new SignalMessage(
                "chat", "room-1", "alice", null, mapper.valueToTree("hello team"))));
        SignalMessage chat = bob.take();
        assertThat(chat.type()).isEqualTo("chat");
        assertThat(chat.from()).isEqualTo("alice");
        assertThat(mapper.convertValue(chat.payload(), String.class)).isEqualTo("hello team");

        // Media state from Alice is broadcast to Bob.
        aliceSession.sendMessage(text(new SignalMessage(
                "state", "room-1", "alice", null,
                mapper.readTree("{\"audio\":false,\"video\":true}"))));
        SignalMessage state = bob.take();
        assertThat(state.type()).isEqualTo("state");
        assertThat(state.from()).isEqualTo("alice");
        assertThat(state.payload().get("audio").asBoolean()).isFalse();
        assertThat(state.payload().get("video").asBoolean()).isTrue();

        // An emoji reaction from Alice is broadcast to Bob.
        aliceSession.sendMessage(text(new SignalMessage(
                "reaction", "room-1", "alice", null, mapper.valueToTree("🎉"))));
        SignalMessage reaction = bob.take();
        assertThat(reaction.type()).isEqualTo("reaction");
        assertThat(reaction.from()).isEqualTo("alice");
        assertThat(mapper.convertValue(reaction.payload(), String.class)).isEqualTo("🎉");

        // When Alice disconnects, Bob is told she left — and inherits the host role.
        aliceSession.close(CloseStatus.NORMAL);
        SignalMessage bobNotice = bob.take();
        assertThat(bobNotice.type()).isEqualTo("peer-left");
        assertThat(bobNotice.from()).isEqualTo("alice");
        SignalMessage handover = bob.take();
        assertThat(handover.type()).isEqualTo("room-state");
        assertThat(handover.payload().get("host").asText()).isEqualTo("bob");

        // A peer joining later receives the room's persisted chat history.
        RecordingHandler carol = new RecordingHandler();
        WebSocketSession carolSession = client
                .execute(carol, new WebSocketHttpHeaders(), signalUri()).get(5, TimeUnit.SECONDS);
        carolSession.sendMessage(text(new SignalMessage(
                "join", "room-1", "carol", null, mapper.valueToTree("Carol"))));
        assertThat(carol.take().type()).isEqualTo("peers");
        assertThat(carol.take().type()).isEqualTo("room-state");
        SignalMessage history = carol.take();
        assertThat(history.type()).isEqualTo("history");
        List<StoredMessage> stored = mapper.convertValue(
                history.payload(), new TypeReference<List<StoredMessage>>() {});
        assertThat(stored).hasSize(1);
        assertThat(stored.get(0).text()).isEqualTo("hello team");
        assertThat(stored.get(0).name()).isEqualTo("Alice");

        carolSession.close(CloseStatus.NORMAL);
        bobSession.close(CloseStatus.NORMAL);
    }

    private TextMessage text(SignalMessage message) throws Exception {
        return new TextMessage(mapper.writeValueAsString(message));
    }

    /** Collects inbound messages into a queue so the test can await them deterministically. */
    private final class RecordingHandler extends TextWebSocketHandler {
        private final BlockingQueue<SignalMessage> inbox = new LinkedBlockingQueue<>();

        @Override
        protected void handleTextMessage(WebSocketSession session, TextMessage message) throws Exception {
            inbox.add(mapper.readValue(message.getPayload(), SignalMessage.class));
        }

        SignalMessage take() throws InterruptedException {
            SignalMessage msg = inbox.poll(5, TimeUnit.SECONDS);
            assertThat(msg).as("expected a signaling message within timeout").isNotNull();
            return msg;
        }
    }
}
