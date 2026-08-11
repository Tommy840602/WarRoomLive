package com.warroomlive.web;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.nimbusds.jose.JWSAlgorithm;
import com.nimbusds.jose.JWSHeader;
import com.nimbusds.jose.crypto.MACSigner;
import com.nimbusds.jose.crypto.MACVerifier;
import com.nimbusds.jwt.JWTClaimsSet;
import com.nimbusds.jwt.SignedJWT;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.http.HttpStatus;
import org.springframework.http.MediaType;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
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

    private static final long CONTROL_TOKEN_TTL_MILLIS = 12 * 60 * 60 * 1000L;

    private final String livekitInternalUrl;
    private final String apiKey;
    private final String apiSecret;
    private final String s3Endpoint;
    private final String s3Bucket;
    private final String s3AccessKey;
    private final String s3SecretKey;
    private final ObjectMapper mapper;
    private final RoomAuthorization authorization;
    private final RestClient rest = RestClient.create();

    public record StopRequest(String egressId, String controlToken) {}

    public RecordingController(
            @Value("${warroomlive.media.livekit-internal-url:}") String livekitInternalUrl,
            @Value("${warroomlive.media.livekit-api-key:}") String apiKey,
            @Value("${warroomlive.media.livekit-api-secret:}") String apiSecret,
            @Value("${warroomlive.media.egress-s3-endpoint:}") String s3Endpoint,
            @Value("${warroomlive.media.egress-s3-bucket:}") String s3Bucket,
            @Value("${warroomlive.media.egress-s3-access-key:}") String s3AccessKey,
            @Value("${warroomlive.media.egress-s3-secret-key:}") String s3SecretKey,
            ObjectMapper mapper,
            RoomAuthorization authorization) {
        this.livekitInternalUrl = livekitInternalUrl;
        this.apiKey = apiKey;
        this.apiSecret = apiSecret;
        this.s3Endpoint = s3Endpoint;
        this.s3Bucket = s3Bucket;
        this.s3AccessKey = s3AccessKey;
        this.s3SecretKey = s3SecretKey;
        this.mapper = mapper;
        this.authorization = authorization;
    }

    private boolean enabled() {
        return !livekitInternalUrl.isBlank() && !apiKey.isBlank() && !apiSecret.isBlank()
                && !s3Endpoint.isBlank() && !s3Bucket.isBlank();
    }

    @PostMapping("/{room}/start")
    public Map<String, String> start(@PathVariable String room) {
        requireEnabled();
        authorization.requireActiveHost(room, "start a recording");
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
        return Map.of(
                "egressId", egressId,
                "controlToken", controlToken(room, egressId, authorization.caller()));
    }

    @PostMapping("/stop")
    public Map<String, String> stop(@RequestBody StopRequest request) {
        requireEnabled();
        if (request.egressId() == null || request.egressId().isBlank()
                || request.controlToken() == null || request.controlToken().isBlank()) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST,
                    "egressId and controlToken are required");
        }
        String room = verifyControlToken(
                request.egressId(), request.controlToken(), authorization.caller());
        authorization.requireHostIfKnown(room, "stop a recording");
        JsonNode info = twirp("StopEgress",
                mapper.createObjectNode().put("egress_id", request.egressId()));
        return Map.of("egressId", request.egressId(),
                "status", info.path("status").asText("EGRESS_ENDING"));
    }

    /**
     * A capability binding an opaque Egress id to its room and starter. It is
     * returned only by the authorized start call and survives backend replicas,
     * unlike an in-memory egress-id map.
     */
    String controlToken(String room, String egressId, String actor) {
        try {
            long now = System.currentTimeMillis();
            JWTClaimsSet claims = new JWTClaimsSet.Builder()
                    .issuer(apiKey)
                    .subject(actor)
                    .notBeforeTime(new Date(now - 10_000))
                    .expirationTime(new Date(now + CONTROL_TOKEN_TTL_MILLIS))
                    .claim("room", room)
                    .claim("egressId", egressId)
                    .build();
            SignedJWT jwt = new SignedJWT(new JWSHeader(JWSAlgorithm.HS256), claims);
            jwt.sign(new MACSigner(apiSecret.getBytes()));
            return jwt.serialize();
        } catch (Exception e) {
            throw new ResponseStatusException(HttpStatus.INTERNAL_SERVER_ERROR,
                    "recording control token signing failed", e);
        }
    }

    String verifyControlToken(String egressId, String encoded, String actor) {
        try {
            SignedJWT jwt = SignedJWT.parse(encoded);
            JWTClaimsSet claims = jwt.getJWTClaimsSet();
            boolean valid = jwt.verify(new MACVerifier(apiSecret.getBytes()))
                    && apiKey.equals(claims.getIssuer())
                    && actor.equals(claims.getSubject())
                    && egressId.equals(claims.getStringClaim("egressId"))
                    && claims.getExpirationTime() != null
                    && claims.getExpirationTime().after(new Date());
            String room = claims.getStringClaim("room");
            if (!valid || room == null || room.isBlank()) {
                throw new ResponseStatusException(HttpStatus.FORBIDDEN,
                        "invalid recording control token");
            }
            return room;
        } catch (ResponseStatusException e) {
            throw e;
        } catch (Exception e) {
            throw new ResponseStatusException(HttpStatus.FORBIDDEN,
                    "invalid recording control token", e);
        }
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
