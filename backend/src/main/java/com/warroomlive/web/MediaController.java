package com.warroomlive.web;

import com.nimbusds.jose.JWSAlgorithm;
import com.nimbusds.jose.JWSHeader;
import com.nimbusds.jose.crypto.MACSigner;
import com.nimbusds.jwt.JWTClaimsSet;
import com.nimbusds.jwt.SignedJWT;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.http.HttpStatus;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.server.ResponseStatusException;

import java.util.Date;
import java.util.Map;

/**
 * Media-plane bootstrap. The frontend asks {@code /api/media/config} which
 * transport to use: {@code mesh} (default, peer-to-peer, capped small rooms) or
 * {@code sfu} when a LiveKit deployment is configured via {@code LIVEKIT_URL}.
 *
 * <p>In SFU mode, {@code /api/media/token} signs a short-lived LiveKit access
 * token (HS256, video grant scoped to one room). The API secret never leaves the
 * server. Note: room-level authorization is the OIDC layer's job — when the
 * {@code oidc} profile is active this endpoint already requires a valid JWT.
 */
@RestController
@RequestMapping("/api/media")
public class MediaController {

    private static final long TOKEN_TTL_SECONDS = 3600;

    private final String livekitUrl;
    private final String apiKey;
    private final String apiSecret;

    public MediaController(
            @Value("${warroomlive.media.livekit-url:}") String livekitUrl,
            @Value("${warroomlive.media.livekit-api-key:}") String apiKey,
            @Value("${warroomlive.media.livekit-api-secret:}") String apiSecret) {
        this.livekitUrl = livekitUrl;
        this.apiKey = apiKey;
        this.apiSecret = apiSecret;
    }

    private boolean sfuEnabled() {
        return !livekitUrl.isBlank() && !apiKey.isBlank() && !apiSecret.isBlank();
    }

    @GetMapping("/config")
    public Map<String, Object> config() {
        return Map.of(
                "mode", sfuEnabled() ? "sfu" : "mesh",
                "livekitUrl", sfuEnabled() ? livekitUrl : "");
    }

    @GetMapping("/token")
    public Map<String, String> token(
            @RequestParam String room,
            @RequestParam String identity,
            @RequestParam(defaultValue = "") String name) {
        if (!sfuEnabled()) {
            throw new ResponseStatusException(HttpStatus.NOT_FOUND, "SFU mode is not configured");
        }
        if (room.isBlank() || identity.isBlank()) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "room and identity are required");
        }
        try {
            long now = System.currentTimeMillis();
            JWTClaimsSet claims = new JWTClaimsSet.Builder()
                    .issuer(apiKey)
                    .subject(identity)
                    .claim("name", name.isBlank() ? identity : name)
                    .notBeforeTime(new Date(now - 10_000))
                    .expirationTime(new Date(now + TOKEN_TTL_SECONDS * 1000))
                    .claim("video", Map.of(
                            "room", room,
                            "roomJoin", true,
                            "canPublish", true,
                            "canSubscribe", true))
                    .build();
            SignedJWT jwt = new SignedJWT(new JWSHeader(JWSAlgorithm.HS256), claims);
            jwt.sign(new MACSigner(apiSecret.getBytes()));
            return Map.of("token", jwt.serialize());
        } catch (Exception e) {
            throw new ResponseStatusException(HttpStatus.INTERNAL_SERVER_ERROR, "token signing failed", e);
        }
    }
}
