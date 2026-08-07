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
 * The server side of client reconnection: a peer that comes back on a new
 * socket must end up in the room exactly once, and a close arriving late for
 * the socket it replaced must not evict it.
 */
@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT)
class ReconnectIntegrationTest {

    @LocalServerPort
    private int port;

    @Autowired
    private ObjectMapper mapper;

    private final StandardWebSocketClient client = new StandardWebSocketClient();

    @Test
    void staleCloseAfterReconnectDoesNotEvictThePeer() throws Exception {
        String room = "reconnect-room";

        Recorder bobRec = new Recorder();
        WebSocketSession bob = connect(bobRec);
        bob.sendMessage(join(room, "bob", "Bob"));
        bobRec.take("peers");

        // Alice joins, then "loses" her connection and comes back on a new one
        // before the server has seen the old socket close.
        Recorder aliceRec = new Recorder();
        WebSocketSession aliceOld = connect(aliceRec);
        aliceOld.sendMessage(join(room, "alice", "Alice"));
        aliceRec.take("peers");
        bobRec.take("peer-joined");

        Recorder aliceNewRec = new Recorder();
        WebSocketSession aliceNew = connect(aliceNewRec);
        aliceNew.sendMessage(join(room, "alice", "Alice"));
        SignalMessage rejoined = aliceNewRec.take("peers");
        assertThat(names(rejoined)).containsExactly("bob");

        // Now the old socket finally closes. Alice must stay in the room and Bob
        // must not be told she left.
        aliceOld.close(CloseStatus.NORMAL);
        Thread.sleep(500);

        Recorder carolRec = new Recorder();
        WebSocketSession carol = connect(carolRec);
        carol.sendMessage(join(room, "carol", "Carol"));
        SignalMessage peers = carolRec.take("peers");
        assertThat(names(peers)).containsExactlyInAnyOrder("alice", "bob");
        assertThat(bobRec.drain()).noneMatch(m -> "peer-left".equals(m.type()));

        // Alice's live socket still works — she is genuinely connected, not a ghost.
        aliceNew.sendMessage(text(new SignalMessage(
                "chat", room, "alice", null, mapper.valueToTree("still here"))));
        assertThat(mapper.convertValue(bobRec.take("chat").payload(), String.class))
                .isEqualTo("still here");

        aliceNew.close(CloseStatus.NORMAL);
        bob.close(CloseStatus.NORMAL);
        carol.close(CloseStatus.NORMAL);
    }

    private List<String> names(SignalMessage peersMessage) {
        return mapper.convertValue(peersMessage.payload(), new com.fasterxml.jackson.core.type.TypeReference<List<PeerInfo>>() {})
                .stream().map(PeerInfo::id).toList();
    }

    private WebSocketSession connect(Recorder handler) throws Exception {
        return client.execute(handler, new WebSocketHttpHeaders(),
                URI.create("ws://localhost:" + port + "/ws/signal")).get(5, TimeUnit.SECONDS);
    }

    private TextMessage join(String room, String id, String name) throws Exception {
        return text(new SignalMessage("join", room, id, null, mapper.valueToTree(name)));
    }

    private TextMessage text(SignalMessage message) throws Exception {
        return new TextMessage(mapper.writeValueAsString(message));
    }

    private final class Recorder extends TextWebSocketHandler {
        private final BlockingQueue<SignalMessage> inbox = new LinkedBlockingQueue<>();

        @Override
        protected void handleTextMessage(WebSocketSession session, TextMessage message) throws Exception {
            inbox.add(mapper.readValue(message.getPayload(), SignalMessage.class));
        }

        /** Awaits the next message of this type, skipping unrelated traffic. */
        SignalMessage take(String type) throws InterruptedException {
            long deadline = System.currentTimeMillis() + 5000;
            while (true) {
                SignalMessage msg = inbox.poll(
                        Math.max(deadline - System.currentTimeMillis(), 1), TimeUnit.MILLISECONDS);
                assertThat(msg).as("expected a '%s' message", type).isNotNull();
                if (msg.type().equals(type)) {
                    return msg;
                }
            }
        }

        List<SignalMessage> drain() {
            return List.copyOf(inbox);
        }
    }
}
