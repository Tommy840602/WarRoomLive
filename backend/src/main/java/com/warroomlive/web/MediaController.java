package com.warroomlive.web;

import com.nimbusds.jose.JWSAlgorithm;
import com.nimbusds.jose.JWSHeader;
import com.nimbusds.jose.crypto.MACSigner;
import com.nimbusds.jwt.JWTClaimsSet;
import com.nimbusds.jwt.SignedJWT;
import com.warroomlive.signaling.Backplane;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.http.HttpStatus;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.server.ResponseStatusException;

import java.util.ArrayList;
import java.util.Date;
import java.util.List;
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
    private final List<Map<String, Object>> iceServers;
    private final Backplane backplane;
    private final int meshMaxPeers;

    public MediaController(
            Backplane backplane,
            @Value("${warroomlive.media.livekit-url:}") String livekitUrl,
            @Value("${warroomlive.media.livekit-api-key:}") String apiKey,
            @Value("${warroomlive.media.livekit-api-secret:}") String apiSecret,
            @Value("${warroomlive.media.stun-urls:stun:stun.l.google.com:19302}") String stunUrls,
            @Value("${warroomlive.media.turn-urls:}") String turnUrls,
            @Value("${warroomlive.media.turn-username:}") String turnUsername,
            @Value("${warroomlive.media.turn-password:}") String turnPassword,
            @Value("${warroomlive.media.mesh-max-peers:8}") int meshMaxPeers) {
        this.backplane = backplane;
        this.meshMaxPeers = meshMaxPeers;
        this.livekitUrl = livekitUrl;
        this.apiKey = apiKey;
        this.apiSecret = apiSecret;
        List<Map<String, Object>> servers = new ArrayList<>();
        if (!stunUrls.isBlank()) {
            servers.add(Map.of("urls", List.of(stunUrls.split("\\s*,\\s*"))));
        }
        if (!turnUrls.isBlank() && !turnUsername.isBlank() && !turnPassword.isBlank()) {
            servers.add(Map.of(
                    "urls", List.of(turnUrls.split("\\s*,\\s*")),
                    "username", turnUsername,
                    "credential", turnPassword));
        }
        this.iceServers = List.copyOf(servers);
    }

    private boolean sfuEnabled() {
        return !livekitUrl.isBlank() && !apiKey.isBlank() && !apiSecret.isBlank();
    }

    /**
     * Which transport to open with.
     *
     * <p>Answered <em>per room</em>, because the answer is a property of the
     * room rather than of the deployment. A room starts on the mesh — for a
     * handful of people nothing beats a direct connection — and moves to the SFU
     * once it grows past {@code warroomlive.media.mesh-max-peers}, at which point
     * asking everyone to upload their video once per peer stops being reasonable.
     *
     * <p>This is only the bootstrap. A room that crosses the limit while somebody
     * is already in it is told over the signaling plane, in {@code room-state} —
     * an HTTP endpoint cannot push, and a client that polled this to find out
     * would learn about the switch seconds late.
     *
     * <p>The room parameter is optional so the lobby can still ask what this
     * deployment is capable of before it has a room to ask about.
     */
    @GetMapping("/config")
    public Map<String, Object> config(@RequestParam(defaultValue = "") String room) {
        boolean sfu = sfuEnabled() && !room.isBlank() && backplane.roomState(room).sfu();
        return Map.of(
                "mode", sfu ? "sfu" : "mesh",
                // Whether there is an SFU at all, separate from whether this room
                // is on it. Without this the UI cannot tell "small room, mesh by
                // design" from "no SFU deployed, and this room is on its own".
                "sfuAvailable", sfuEnabled(),
                "meshMaxPeers", meshMaxPeers,
                "livekitUrl", sfuEnabled() ? livekitUrl : "",
                "iceServers", iceServers);
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
