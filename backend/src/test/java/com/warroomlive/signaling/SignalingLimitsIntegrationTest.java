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
import java.util.concurrent.LinkedBlockingQueue;
import java.util.concurrent.TimeUnit;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * Abuse limits over the real endpoint. The property worth protecting is that a
 * misbehaving connection is contained without taking the room down with it.
 */
@SpringBootTest(
        webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT,
        properties = {
                "warroomlive.signaling.max-messages-per-second=10",
                "warroomlive.chat.max-length=50",
        })
class SignalingLimitsIntegrationTest {

    @LocalServerPort
    private int port;

    @Autowired
    private ObjectMapper mapper;

    private final StandardWebSocketClient client = new StandardWebSocketClient();

    @Test
    void overlongChatIsRejectedAndNotStored() throws Exception {
        String room = "limits-chat";
        Recorder aliceRec = new Recorder();
        WebSocketSession alice = join(aliceRec, room, "alice");
        Recorder bobRec = new Recorder();
        WebSocketSession bob = join(bobRec, room, "bob");
        aliceRec.take("peer-joined");

        alice.sendMessage(text(new SignalMessage(
                "chat", room, "alice", null, mapper.valueToTree("x".repeat(51)))));
        SignalMessage error = aliceRec.take("error");
        assertThat(mapper.convertValue(error.payload(), String.class)).contains("exceeds 50");

        // The room never saw it, and a message within the limit still works.
        alice.sendMessage(text(new SignalMessage(
                "chat", room, "alice", null, mapper.valueToTree("short enough"))));
        SignalMessage delivered = bobRec.take("chat");
        assertThat(mapper.convertValue(delivered.payload(), String.class)).isEqualTo("short enough");
        assertThat(bobRec.drain()).noneMatch(m ->
                "chat".equals(m.type()) && String.valueOf(m.payload()).contains("xxx"));

        alice.close(CloseStatus.NORMAL);
        bob.close(CloseStatus.NORMAL);
    }

    @Test
    void aFloodingConnectionIsThrottledWithoutHarmingTheRoom() throws Exception {
        String room = "limits-rate";
        Recorder victimRec = new Recorder();
        WebSocketSession victim = join(victimRec, room, "victim");
        Recorder floodRec = new Recorder();
        WebSocketSession flooder = join(floodRec, room, "flooder");
        victimRec.take("peer-joined");

        // Far beyond the 10/s allowance (burst 20) in one go.
        for (int i = 0; i < 200; i++) {
            flooder.sendMessage(text(new SignalMessage(
                    "chat", room, "flooder", null, mapper.valueToTree("spam-" + i))));
        }
        Thread.sleep(1500);

        long delivered = victimRec.drain().stream().filter(m -> "chat".equals(m.type())).count();
        assertThat(delivered)
                .as("most of the flood is dropped")
                .isLessThan(60);
        assertThat(delivered).as("but the connection kept working").isGreaterThan(0);

        // The flooder's own connection is still open — throttling is not a kick —
        // and the victim can still use the room.
        assertThat(flooder.isOpen()).isTrue();
        assertThat(victim.isOpen()).isTrue();
        victim.sendMessage(text(new SignalMessage(
                "chat", room, "victim", null, mapper.valueToTree("still able to talk"))));
        assertThat(mapper.convertValue(floodRec.take("chat").payload(), String.class))
                .isEqualTo("still able to talk");

        victim.close(CloseStatus.NORMAL);
        flooder.close(CloseStatus.NORMAL);
    }

    private WebSocketSession join(Recorder handler, String room, String id) throws Exception {
        WebSocketSession session = client.execute(handler, new WebSocketHttpHeaders(),
                URI.create("ws://localhost:" + port + "/ws/signal")).get(5, TimeUnit.SECONDS);
        session.sendMessage(text(new SignalMessage(
                "join", room, id, null, mapper.valueToTree(id))));
        handler.take("peers");
        return session;
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

        java.util.List<SignalMessage> drain() {
            return java.util.List.copyOf(inbox);
        }
    }
}
