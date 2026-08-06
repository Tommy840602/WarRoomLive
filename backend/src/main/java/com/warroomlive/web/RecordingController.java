package com.warroomlive.web;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.nimbusds.jose.JWSAlgorithm;
import com.nimbusds.jose.JWSHeader;
import com.nimbusds.jose.crypto.MACSigner;
import com.nimbusds.jwt.JWTClaimsSet;
import com.nimbusds.jwt.SignedJWT;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.http.HttpStatus;
import org.springframework.http.MediaType;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.client.RestClient;
import org.springframework.web.server.ResponseStatusException;

import java.util.Date;
import java.util.Map;

/**
 * Meeting recording via LiveKit Egress: room-composite MP4s uploaded straight to
 * S3-compatible storage (MinIO in the recording overlay). The backend is the only
 * party that talks to the Egress twirp API — browsers just hit these endpoints,
 * and neither the LiveKit secret nor the storage credentials ever leave the
 * server. Requires the recording overlay (404 otherwise). Completion is reported
 * asynchronously through the LiveKit webhook (see {@code LiveKitWebhookController}).
 */
@RestController
@RequestMapping("/api/media/recordings")
public class RecordingController {

    private final String livekitInternalUrl;
    private final String apiKey;
    private final String apiSecret;
    private final String s3Endpoint;
    private final String s3Bucket;
    private final String s3AccessKey;
    private final String s3SecretKey;
    private final ObjectMapper mapper;
    private final RestClient rest = RestClient.create();

    public RecordingController(
            @Value("${warroomlive.media.livekit-internal-url:}") String livekitInternalUrl,
            @Value("${warroomlive.media.livekit-api-key:}") String apiKey,
            @Value("${warroomlive.media.livekit-api-secret:}") String apiSecret,
            @Value("${warroomlive.media.egress-s3-endpoint:}") String s3Endpoint,
            @Value("${warroomlive.media.egress-s3-bucket:}") String s3Bucket,
            @Value("${warroomlive.media.egress-s3-access-key:}") String s3AccessKey,
            @Value("${warroomlive.media.egress-s3-secret-key:}") String s3SecretKey,
            ObjectMapper mapper) {
        this.livekitInternalUrl = livekitInternalUrl;
        this.apiKey = apiKey;
        this.apiSecret = apiSecret;
        this.s3Endpoint = s3Endpoint;
        this.s3Bucket = s3Bucket;
        this.s3AccessKey = s3AccessKey;
        this.s3SecretKey = s3SecretKey;
        this.mapper = mapper;
    }

    private boolean enabled() {
        return !livekitInternalUrl.isBlank() && !apiKey.isBlank() && !apiSecret.isBlank()
                && !s3Endpoint.isBlank() && !s3Bucket.isBlank();
    }

    @PostMapping("/{room}/start")
    public Map<String, String> start(@PathVariable String room) {
        requireEnabled();
        ObjectNode s3 = mapper.createObjectNode()
                .put("access_key", s3AccessKey)
                .put("secret", s3SecretKey)
                .put("endpoint", s3Endpoint)
                .put("bucket", s3Bucket)
                .put("region", "us-east-1")
                .put("force_path_style", true);
        ObjectNode fileOutput = mapper.createObjectNode()
                .put("filepath", room + "-{time}.mp4");
        fileOutput.set("s3", s3);
        ObjectNode request = mapper.createObjectNode().put("room_name", room);
        request.putArray("file_outputs").add(fileOutput);

        JsonNode info = twirp("StartRoomCompositeEgress", request);
        String egressId = info.path("egress_id").asText(info.path("egressId").asText());
        if (egressId.isBlank()) {
            throw new ResponseStatusException(HttpStatus.BAD_GATEWAY, "egress did not return an id: " + info);
        }
        return Map.of("egressId", egressId);
    }

    @PostMapping("/stop")
    public Map<String, String> stop(@RequestParam String egressId) {
        requireEnabled();
        JsonNode info = twirp("StopEgress", mapper.createObjectNode().put("egress_id", egressId));
        return Map.of("egressId", egressId,
                "status", info.path("status").asText("EGRESS_ENDING"));
    }

    private JsonNode twirp(String method, ObjectNode body) {
        try {
            JWTClaimsSet claims = new JWTClaimsSet.Builder()
                    .issuer(apiKey)
                    .notBeforeTime(new Date(System.currentTimeMillis() - 10_000))
                    .expirationTime(new Date(System.currentTimeMillis() + 60_000))
                    .claim("video", Map.of("roomRecord", true))
                    .build();
            SignedJWT jwt = new SignedJWT(new JWSHeader(JWSAlgorithm.HS256), claims);
            jwt.sign(new MACSigner(apiSecret.getBytes()));

            String response = rest.post()
                    .uri(livekitInternalUrl + "/twirp/livekit.Egress/" + method)
                    .contentType(MediaType.APPLICATION_JSON)
                    .header("Authorization", "Bearer " + jwt.serialize())
                    .body(mapper.writeValueAsString(body))
                    .retrieve()
                    .body(String.class);
            return mapper.readTree(response);
        } catch (ResponseStatusException e) {
            throw e;
        } catch (Exception e) {
            throw new ResponseStatusException(HttpStatus.BAD_GATEWAY,
                    "egress " + method + " failed: " + e.getMessage(), e);
        }
    }

    private void requireEnabled() {
        if (!enabled()) {
            throw new ResponseStatusException(HttpStatus.NOT_FOUND, "recording is not configured");
        }
    }
}
