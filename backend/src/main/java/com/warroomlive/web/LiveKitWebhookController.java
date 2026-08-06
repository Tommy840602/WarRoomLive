package com.warroomlive.web;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.nimbusds.jose.crypto.MACVerifier;
import com.nimbusds.jwt.SignedJWT;
import com.warroomlive.events.OutboxRecorder;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.ObjectProvider;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.http.HttpStatus;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestHeader;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.server.ResponseStatusException;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.Base64;
import java.util.Map;

/**
 * Receives LiveKit webhooks (recording overlay). Each delivery carries a JWT in
 * the Authorization header signed with the LiveKit API secret whose {@code sha256}
 * claim hashes the body — verified here, so the endpoint authenticates itself and
 * sits on the security permit list. {@code egress_ended} becomes a
 * {@code meeting.recording.completed} event on the backbone (kafka profile).
 */
@RestController
public class LiveKitWebhookController {

    private static final Logger log = LoggerFactory.getLogger(LiveKitWebhookController.class);

    private final String apiKey;
    private final String apiSecret;
    private final ObjectMapper mapper;
    private final ObjectProvider<OutboxRecorder> outbox;

    public LiveKitWebhookController(
            @Value("${warroomlive.media.livekit-api-key:}") String apiKey,
            @Value("${warroomlive.media.livekit-api-secret:}") String apiSecret,
            ObjectMapper mapper,
            ObjectProvider<OutboxRecorder> outbox) {
        this.apiKey = apiKey;
        this.apiSecret = apiSecret;
        this.mapper = mapper;
        this.outbox = outbox;
    }

    @PostMapping("/api/livekit/webhook")
    public void webhook(
            @RequestHeader(value = "Authorization", required = false) String authorization,
            @RequestBody String body) {
        verify(authorization, body);

        JsonNode event;
        try {
            event = mapper.readTree(body);
        } catch (Exception e) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "malformed webhook body");
        }

        if (!"egress_ended".equals(event.path("event").asText())) {
            return; // room/participant webhooks are informational here
        }
        JsonNode info = event.path("egressInfo");
        String room = info.path("roomName").asText();
        String egressId = info.path("egressId").asText();
        JsonNode file = info.path("fileResults").path(0);
        String location = file.path("location").asText(file.path("filename").asText());
        long sizeBytes = file.path("size").asLong();
        log.info("Recording completed for room {} ({}, {} bytes) at {}", room, egressId, sizeBytes, location);
        outbox.ifAvailable(recorder -> recorder.record(
                "meeting.recording.completed", "room", room,
                Map.of("egressId", egressId, "location", location, "sizeBytes", sizeBytes)));
    }

    /** LiveKit webhook auth: HS256 JWT (iss = api key) whose sha256 claim hashes the body. */
    private void verify(String authorization, String body) {
        if (apiSecret.isBlank()) {
            throw new ResponseStatusException(HttpStatus.NOT_FOUND, "webhooks are not configured");
        }
        try {
            String token = authorization == null ? "" : authorization.replaceFirst("^Bearer ", "").trim();
            SignedJWT jwt = SignedJWT.parse(token);
            if (!jwt.verify(new MACVerifier(apiSecret.getBytes()))
                    || !apiKey.equals(jwt.getJWTClaimsSet().getIssuer())) {
                throw new IllegalArgumentException("bad signature or issuer");
            }
            byte[] digest = MessageDigest.getInstance("SHA-256").digest(body.getBytes(StandardCharsets.UTF_8));
            String expected = Base64.getEncoder().encodeToString(digest);
            if (!expected.equals(jwt.getJWTClaimsSet().getStringClaim("sha256"))) {
                throw new IllegalArgumentException("body hash mismatch");
            }
        } catch (ResponseStatusException e) {
            throw e;
        } catch (Exception e) {
            throw new ResponseStatusException(HttpStatus.UNAUTHORIZED, "webhook verification failed");
        }
    }
}
