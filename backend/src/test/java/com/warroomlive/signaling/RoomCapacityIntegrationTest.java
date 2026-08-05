package com.warroomlive.signaling;

import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.web.server.LocalServerPort;
import org.springframework.test.context.TestPropertySource;
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

/** Verifies that a room at capacity rejects further joins with a {@code room-full} message. */
@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT)
@TestPropertySource(properties = "warroomlive.signaling.max-room-size=2")
class RoomCapacityIntegrationTest {

    @LocalServerPort
    private int port;

    @Autowired
    private ObjectMapper mapper;

    @Test
    void thirdJoinIntoAFullRoomIsRejected() throws Exception {
        StandardWebSocketClient client = new StandardWebSocketClient();
        URI uri = URI.create("ws://localhost:" + port + "/ws/signal");

        // Fill the room (capacity 2).
        for (String peer : new String[] {"p1", "p2"}) {
            Recorder r = new Recorder();
            WebSocketSession s = client.execute(r, new WebSocketHttpHeaders(), uri).get(5, TimeUnit.SECONDS);
            s.sendMessage(text(new SignalMessage("join", "full-room", peer, null, mapper.valueToTree(peer))));
            assertThat(r.take().type()).isEqualTo("peers");
        }

        // A third peer is turned away.
        Recorder third = new Recorder();
        WebSocketSession s3 = client.execute(third, new WebSocketHttpHeaders(), uri).get(5, TimeUnit.SECONDS);
        s3.sendMessage(text(new SignalMessage("join", "full-room", "p3", null, mapper.valueToTree("p3"))));

        SignalMessage rejected = third.take();
        assertThat(rejected.type()).isEqualTo("room-full");
        assertThat(mapper.convertValue(rejected.payload(), Integer.class)).isEqualTo(2);
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

        SignalMessage take() throws InterruptedException {
            SignalMessage msg = inbox.poll(5, TimeUnit.SECONDS);
            assertThat(msg).as("expected a signaling message within timeout").isNotNull();
            return msg;
        }
    }
}
