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
import java.util.concurrent.BlockingQueue;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.LinkedBlockingQueue;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * Room-level access control against the real {@code /ws/signal} endpoint: host
 * assignment and handover, host-only lock/kick enforcement (including sender
 * spoofing), locked-room join rejection, and the kicked peer's 4403 close.
 */
@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT)
class RoomAclIntegrationTest {

    private static final String ROOM = "acl-room";

    @LocalServerPort
    private int port;

    @Autowired
    private ObjectMapper mapper;

    private final StandardWebSocketClient client = new StandardWebSocketClient();

    @Test
    void hostControlsLockAndKick() throws Exception {
        // Alice opens the room and becomes host.
        Peer alice = join("alice", "Alice");
        assertThat(alice.take("room-state").payload().get("host").asText()).isEqualTo("alice");

        Peer bob = join("bob", "Bob");
        assertThat(bob.take("room-state").payload().get("host").asText()).isEqualTo("alice");
        alice.take("peer-joined");

        // A non-host cannot lock the room.
        bob.send(new SignalMessage("lock", ROOM, "bob", null, mapper.valueToTree(true)));
        assertThat(text(bob.take("error"))).contains("only the host");

        // A peer cannot act as someone it did not join as (spoofed 'from').
        bob.send(new SignalMessage("lock", ROOM, "alice", null, mapper.valueToTree(true)));
        assertThat(text(bob.take("error"))).contains("does not match");
        bob.send(new SignalMessage("kick", ROOM, "alice", "bob", null));
        assertThat(text(bob.take("error"))).contains("does not match");

        // The host locks the room: everyone sees the new state, newcomers bounce.
        alice.send(new SignalMessage("lock", ROOM, "alice", null, mapper.valueToTree(true)));
        assertThat(alice.take("room-state").payload().get("locked").asBoolean()).isTrue();
        assertThat(bob.take("room-state").payload().get("locked").asBoolean()).isTrue();

        Peer carol = new Peer("carol");
        carol.connect();
        carol.send(new SignalMessage("join", ROOM, "carol", null, mapper.valueToTree("Carol")));
        carol.take("room-locked");

        // Reconnecting members still pass the lock (re-register of an existing member).
        alice.send(new SignalMessage("join", ROOM, "alice", null, mapper.valueToTree("Alice")));
        alice.take("peers");
        assertThat(alice.take("room-state").payload().get("locked").asBoolean()).isTrue();

        // Unlock: the newcomer now gets in.
        alice.send(new SignalMessage("lock", ROOM, "alice", null, mapper.valueToTree(false)));
        assertThat(alice.take("room-state").payload().get("locked").asBoolean()).isFalse();
        assertThat(bob.take("room-state").payload().get("locked").asBoolean()).isFalse();
        carol.send(new SignalMessage("join", ROOM, "carol", null, mapper.valueToTree("Carol")));
        carol.take("peers");
        alice.take("peer-joined");
        bob.take("peer-joined");

        // The host kicks Carol: she gets the notice, her socket closes with 4403,
        // and the rest of the room sees her leave.
        alice.send(new SignalMessage("kick", ROOM, "alice", "carol", null));
        SignalMessage kicked = carol.take("kicked");
        assertThat(text(kicked)).isEqualTo("alice");
        assertThat(carol.awaitClose()).isEqualTo(4403);
        assertThat(alice.take("peer-left").from()).isEqualTo("carol");
        assertThat(bob.take("peer-left").from()).isEqualTo("carol");
        alice.take("room-state");
        bob.take("room-state");

        // Host leaves: Bob (longest-present member) inherits the role.
        alice.close();
        assertThat(bob.take("peer-left").from()).isEqualTo("alice");
        assertThat(bob.take("room-state").payload().get("host").asText()).isEqualTo("bob");

        // The new host's powers are real: Bob can now lock.
        bob.send(new SignalMessage("lock", ROOM, "bob", null, mapper.valueToTree(true)));
        assertThat(bob.take("room-state").payload().get("locked").asBoolean()).isTrue();

        bob.close();
    }

    private Peer join(String id, String name) throws Exception {
        Peer peer = new Peer(id);
        peer.connect();
        peer.send(new SignalMessage("join", ROOM, id, null, mapper.valueToTree(name)));
        peer.take("peers");
        return peer;
    }

    private String text(SignalMessage msg) {
        return mapper.convertValue(msg.payload(), String.class);
    }

    /** One WebSocket client: awaitable inbox plus the close code for kick assertions. */
    private final class Peer extends TextWebSocketHandler {
        private final String id;
        private final BlockingQueue<SignalMessage> inbox = new LinkedBlockingQueue<>();
        private final CountDownLatch closed = new CountDownLatch(1);
        private final AtomicReference<CloseStatus> closeStatus = new AtomicReference<>();
        private WebSocketSession session;

        Peer(String id) {
            this.id = id;
        }

        void connect() throws Exception {
            session = client.execute(this, new WebSocketHttpHeaders(),
                    URI.create("ws://localhost:" + port + "/ws/signal")).get(5, TimeUnit.SECONDS);
        }

        void send(SignalMessage message) throws Exception {
            session.sendMessage(new TextMessage(mapper.writeValueAsString(message)));
        }

        /** Awaits the next message of the given type, skipping unrelated traffic. */
        SignalMessage take(String type) throws InterruptedException {
            long deadline = System.currentTimeMillis() + 5000;
            while (true) {
                long left = deadline - System.currentTimeMillis();
                SignalMessage msg = inbox.poll(Math.max(left, 1), TimeUnit.MILLISECONDS);
                assertThat(msg).as("%s expected a '%s' message within timeout", id, type).isNotNull();
                if (msg.type().equals(type)) {
                    return msg;
                }
            }
        }

        int awaitClose() throws InterruptedException {
            assertThat(closed.await(5, TimeUnit.SECONDS))
                    .as("%s expected the server to close the connection", id).isTrue();
            return closeStatus.get().getCode();
        }

        void close() throws Exception {
            session.close(CloseStatus.NORMAL);
        }

        @Override
        protected void handleTextMessage(WebSocketSession session, TextMessage message) throws Exception {
            inbox.add(mapper.readValue(message.getPayload(), SignalMessage.class));
        }

        @Override
        public void afterConnectionClosed(WebSocketSession session, CloseStatus status) {
            closeStatus.set(status);
            closed.countDown();
        }
    }
}
