package com.warroomlive.web;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.warroomlive.signaling.LocalBackplane;
import org.junit.jupiter.api.Test;
import org.springframework.web.server.ResponseStatusException;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

class RecordingControlTokenTest {

    private static final String SECRET = "devkey_secret_needs_at_least_32_bytes";

    private final RecordingController controller = new RecordingController(
            "http://livekit:7880", "devkey", SECRET,
            "http://minio:9000", "recordings", "access", "secret",
            new ObjectMapper(), new RoomAuthorization(new LocalBackplane()));

    @Test
    void controlTokenBindsEgressRoomAndActor() {
        String token = controller.controlToken("room-a", "EG_123", "alice");

        assertThat(controller.verifyControlToken("EG_123", token, "alice"))
                .isEqualTo("room-a");
        assertForbidden(() -> controller.verifyControlToken("EG_other", token, "alice"));
        assertForbidden(() -> controller.verifyControlToken("EG_123", token, "bob"));
        assertForbidden(() -> controller.verifyControlToken("EG_123", token + "x", "alice"));
    }

    @Test
    void stopRejectsAnIncompleteCapabilityBeforeCallingEgress() {
        assertThatThrownBy(() -> controller.stop(
                new RecordingController.StopRequest("EG_123", "")))
                .isInstanceOf(ResponseStatusException.class)
                .extracting(error -> ((ResponseStatusException) error).getStatusCode().value())
                .isEqualTo(400);
    }

    private static void assertForbidden(Runnable action) {
        assertThatThrownBy(action::run)
                .isInstanceOf(ResponseStatusException.class)
                .extracting(error -> ((ResponseStatusException) error).getStatusCode().value())
                .isEqualTo(403);
    }
}
