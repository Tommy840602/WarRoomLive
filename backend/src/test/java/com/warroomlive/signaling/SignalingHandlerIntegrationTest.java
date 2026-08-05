package com.warroomlive.signaling;

import com.fasterxml.jackson.databind.ObjectMapper;
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
        aliceSession.sendMessage(text(new SignalMessage("join", "room-1", "alice", null, null)));

        SignalMessage alicePeers = alice.take();
        assertThat(alicePeers.type()).isEqualTo("peers");
        assertThat(mapper.convertValue(alicePeers.payload(), List.class)).isEmpty();

        // Bob joins the same room.
        RecordingHandler bob = new RecordingHandler();
        WebSocketSession bobSession = client
                .execute(bob, new WebSocketHttpHeaders(), signalUri()).get(5, TimeUnit.SECONDS);
        bobSession.sendMessage(text(new SignalMessage("join", "room-1", "bob", null, null)));

        // Bob sees Alice already present.
        SignalMessage bobPeers = bob.take();
        assertThat(bobPeers.type()).isEqualTo("peers");
        assertThat(mapper.convertValue(bobPeers.payload(), List.class)).containsExactly("alice");

        // Alice is notified that Bob arrived.
        SignalMessage aliceNotice = alice.take();
        assertThat(aliceNotice.type()).isEqualTo("peer-joined");
        assertThat(aliceNotice.from()).isEqualTo("bob");

        // Alice sends Bob an offer; it is relayed verbatim.
        aliceSession.sendMessage(text(new SignalMessage(
                "offer", "room-1", "alice", "bob", mapper.valueToTree("sdp-blob"))));
        SignalMessage relayed = bob.take();
        assertThat(relayed.type()).isEqualTo("offer");
        assertThat(relayed.from()).isEqualTo("alice");
        assertThat(mapper.convertValue(relayed.payload(), String.class)).isEqualTo("sdp-blob");

        // When Alice disconnects, Bob is told she left.
        aliceSession.close(CloseStatus.NORMAL);
        SignalMessage bobNotice = bob.take();
        assertThat(bobNotice.type()).isEqualTo("peer-left");
        assertThat(bobNotice.from()).isEqualTo("alice");

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
