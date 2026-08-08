package com.warroomlive.web;

import com.nimbusds.jose.crypto.MACVerifier;
import com.nimbusds.jwt.SignedJWT;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.web.client.TestRestTemplate;
import org.springframework.http.ResponseEntity;

import java.util.Map;

import static org.assertj.core.api.Assertions.assertThat;

@SpringBootTest(
        webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT,
        properties = {
                "warroomlive.media.livekit-url=/livekit",
                "warroomlive.media.livekit-api-key=devkey",
                "warroomlive.media.livekit-api-secret=devkey_secret_needs_at_least_32_bytes",
        })
class MediaControllerIntegrationTest {

    @Autowired
    private TestRestTemplate rest;

    @Autowired
    private com.warroomlive.signaling.Backplane backplane;

    @Test
    @SuppressWarnings("unchecked")
    void aSmallRoomStaysOnTheMeshEvenWhereAnSfuExists() {
        // The mode is a property of the room, not of the deployment. Having an
        // SFU available does not mean four people should be routed through it —
        // for a handful of participants a direct connection is the fastest path
        // there is, and the SFU only earns its hop once the room outgrows one.
        Map<String, Object> config = rest.getForObject("/api/media/config?room=small", Map.class);
        assertThat(config)
                .containsEntry("mode", "mesh")
                .containsEntry("sfuAvailable", true)
                .containsEntry("meshMaxPeers", 8)
                .containsEntry("livekitUrl", "/livekit");
    }

    @Test
    @SuppressWarnings("unchecked")
    void aRoomThatHasOutgrownTheMeshIsPutStraightOnTheSfu() {
        // A joiner arriving at a room that already switched must not negotiate a
        // mesh it is about to be moved off.
        backplane.tryRegister("big", "someone", "Someone", null, 50);
        backplane.markSfu("big");

        Map<String, Object> config = rest.getForObject("/api/media/config?room=big", Map.class);
        assertThat(config).containsEntry("mode", "sfu");
    }

    @Test
    @SuppressWarnings("unchecked")
    void theLobbyCanAskWhatTheDeploymentCanDoWithoutNamingARoom() {
        Map<String, Object> config = rest.getForObject("/api/media/config", Map.class);
        assertThat(config).containsEntry("mode", "mesh").containsEntry("sfuAvailable", true);
    }

    @Test
    @SuppressWarnings("unchecked")
    void tokenCarriesRoomScopedVideoGrantSignedWithApiSecret() throws Exception {
        Map<String, String> body = rest.getForObject(
                "/api/media/token?room=war-room&identity=alice&name=Alice", Map.class);

        SignedJWT jwt = SignedJWT.parse(body.get("token"));
        assertThat(jwt.verify(new MACVerifier("devkey_secret_needs_at_least_32_bytes".getBytes())))
                .as("HMAC signature must validate against the API secret")
                .isTrue();

        var claims = jwt.getJWTClaimsSet();
        assertThat(claims.getIssuer()).isEqualTo("devkey");
        assertThat(claims.getSubject()).isEqualTo("alice");
        assertThat(claims.getStringClaim("name")).isEqualTo("Alice");
        Map<String, Object> video = (Map<String, Object>) claims.getClaim("video");
        assertThat(video)
                .containsEntry("room", "war-room")
                .containsEntry("roomJoin", true)
                .containsEntry("canPublish", true)
                .containsEntry("canSubscribe", true);
        assertThat(claims.getExpirationTime()).isInTheFuture();
    }

    @Test
    void missingParamsAreRejected() {
        ResponseEntity<String> response = rest.getForEntity("/api/media/token?room=&identity=x", String.class);
        assertThat(response.getStatusCode().value()).isEqualTo(400);
    }
}
