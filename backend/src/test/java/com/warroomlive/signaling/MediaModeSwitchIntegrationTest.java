package com.warroomlive.signaling;

import com.fasterxml.jackson.databind.JsonNode;
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
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.TimeUnit;

import static org.assertj.core.api.Assertions.assertThat;
import static org.awaitility.Awaitility.await;

/**
 * A room that outgrows the mesh moves to the SFU, and everybody is told.
 *
 * <p>Driven through the real {@code /ws/signal} endpoint, like the other
 * signaling tests: the interesting behaviour is the message every existing
 * participant receives when the limit is crossed, and a unit test of the handler
 * would assert the call rather than the announcement.
 *
 * <p>The mesh limit is set to 2 here so the test does not need nine sockets. The
 * threshold is configuration; what is being tested is what happens at it.
 */
@SpringBootTest(
        webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT,
        properties = {
                "warroomlive.media.mesh-max-peers=2",
                "warroomlive.signaling.max-room-size=8",
                "warroomlive.media.livekit-url=/livekit",
                "warroomlive.media.livekit-api-key=devkey",
                "warroomlive.media.livekit-api-secret=devkey_secret_needs_at_least_32_bytes",
        })
class MediaModeSwitchIntegrationTest {

    private static final ObjectMapper MAPPER = new ObjectMapper();

    @LocalServerPort
    private int port;

    @Autowired
    private Backplane backplane;

    /** Collects every message a client receives, for asserting on afterwards. */
    private static final class Recorder extends TextWebSocketHandler {
        final List<JsonNode> received = new ArrayList<>();

        @Override
        public void handleTextMessage(WebSocketSession session, TextMessage message) throws Exception {
            synchronized (received) {
                received.add(MAPPER.readTree(message.getPayload()));
            }
        }

        List<JsonNode> ofType(String type) {
            synchronized (received) {
                return received.stream().filter(m -> type.equals(m.path("type").asText())).toList();
            }
        }
    }

    private WebSocketSession connect(Recorder recorder) throws Exception {
        return new StandardWebSocketClient()
                .execute(recorder, new WebSocketHttpHeaders(),
                        URI.create("ws://localhost:" + port + "/ws/signal"))
                .get(5, TimeUnit.SECONDS);
    }

    private static void join(WebSocketSession session, String room, String peer) throws Exception {
        session.sendMessage(new TextMessage(
                "{\"type\":\"join\",\"room\":\"" + room + "\",\"from\":\"" + peer
                        + "\",\"payload\":\"" + peer + "\"}"));
    }

    private static String modeIn(List<JsonNode> roomStates) {
        return roomStates.isEmpty() ? null
                : roomStates.get(roomStates.size() - 1).path("payload").path("mediaMode").asText();
    }

    @Test
    void theRoomMovesToTheSfuWhenItOutgrowsTheMeshAndEveryoneIsTold() throws Exception {
        String room = "outgrow-" + System.nanoTime();
        Recorder first = new Recorder();
        Recorder second = new Recorder();
        Recorder third = new Recorder();

        WebSocketSession a = connect(first);
        join(a, room, "a");
        await().atMost(5, TimeUnit.SECONDS).until(() -> !first.ofType("room-state").isEmpty());
        assertThat(modeIn(first.ofType("room-state")))
                .as("a room of one is a mesh")
                .isEqualTo("mesh");

        WebSocketSession b = connect(second);
        join(b, room, "b");
        await().atMost(5, TimeUnit.SECONDS).until(() -> !second.ofType("room-state").isEmpty());
        assertThat(modeIn(second.ofType("room-state")))
                .as("and so is a room at the limit")
                .isEqualTo("mesh");

        // The one that tips it over.
        WebSocketSession c = connect(third);
        join(c, room, "c");

        await().atMost(5, TimeUnit.SECONDS)
                .until(() -> "sfu".equals(modeIn(first.ofType("room-state"))));
        assertThat(modeIn(second.ofType("room-state")))
                .as("everyone already in the room is told, not just the newcomer")
                .isEqualTo("sfu");
        assertThat(modeIn(third.ofType("room-state")))
                .as("and the arrival that caused it is told the mode it is actually joining")
                .isEqualTo("sfu");
        assertThat(third.ofType("room-state"))
                .as("told once, not twice — the join sequence already sends it")
                .hasSize(1);

        // The latch: dropping back under the limit must not switch back, or a
        // room hovering at the threshold would renegotiate all meeting.
        c.close(CloseStatus.NORMAL);
        await().atMost(5, TimeUnit.SECONDS).until(() -> backplane.peersIn(room).size() == 2);
        assertThat(backplane.roomState(room).sfu())
                .as("a room that shrinks stays on the SFU")
                .isTrue();

        Recorder fourth = new Recorder();
        WebSocketSession d = connect(fourth);
        join(d, room, "d");
        await().atMost(5, TimeUnit.SECONDS).until(() -> !fourth.ofType("room-state").isEmpty());
        assertThat(modeIn(fourth.ofType("room-state")))
                .as("and a later joiner is put straight onto it")
                .isEqualTo("sfu");

        a.close(CloseStatus.NORMAL);
        b.close(CloseStatus.NORMAL);
        d.close(CloseStatus.NORMAL);

        // The latch belongs to the room, not to the name: once everybody leaves,
        // the next meeting in the same room starts on the mesh again.
        await().atMost(5, TimeUnit.SECONDS).until(() -> backplane.peersIn(room).isEmpty());
        assertThat(backplane.roomState(room).sfu())
                .as("an empty room forgets it ever grew")
                .isFalse();
    }
}
