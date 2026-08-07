package com.warroomlive.web;

import com.warroomlive.recordings.RecordingEntity;
import com.warroomlive.recordings.RecordingStore;
import com.warroomlive.recordings.S3Presigner;
import org.springframework.beans.factory.ObjectProvider;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.http.HttpStatus;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.server.ResponseStatusException;

import java.time.Duration;
import java.time.Instant;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

/**
 * Lists a room's finished recordings and hands out short-lived playback URLs.
 *
 * <p>Recordings were reaching object storage with no way to watch them from the
 * app. Playback is a presigned GET rather than a proxied stream: the object
 * store's credentials stay here, the URL authorises one object for a few
 * minutes, and the bytes never pass through this server.
 *
 * <p>The signed host is the *browser's* origin host, because SigV4 covers the
 * host header — nginx forwards the request to the object store while preserving
 * the path, so what the browser sends is what was signed.
 */
@RestController
@RequestMapping("/api/recordings")
public class RecordingLibraryController {

    /** Long enough to start playback and seek around, short enough to be worthless if leaked. */
    private static final Duration PLAYBACK_TTL = Duration.ofMinutes(30);
    /** A busy room accumulates recordings indefinitely, so the list is a page, not the lot. */
    private static final int DEFAULT_LIMIT = 50;
    private static final int MAX_LIMIT = 200;

    private final ObjectProvider<RecordingStore> recordings;
    private final RoomAuthorization authorization;
    private final String bucket;
    private final String accessKey;
    private final String secretKey;
    private final String publicPrefix;
    /** Host of the object store as the proxy reaches it — this is what gets signed. */
    private final String storeHost;

    public RecordingLibraryController(
            ObjectProvider<RecordingStore> recordings,
            RoomAuthorization authorization,
            @Value("${warroomlive.media.egress-s3-endpoint:}") String endpoint,
            @Value("${warroomlive.media.egress-s3-bucket:}") String bucket,
            @Value("${warroomlive.media.egress-s3-access-key:}") String accessKey,
            @Value("${warroomlive.media.egress-s3-secret-key:}") String secretKey,
            @Value("${warroomlive.media.recording-path-prefix:/recordings}") String publicPrefix) {
        this.recordings = recordings;
        this.authorization = authorization;
        this.bucket = bucket;
        this.accessKey = accessKey;
        this.secretKey = secretKey;
        this.publicPrefix = publicPrefix;
        this.storeHost = hostOf(endpoint);
    }

    private static String hostOf(String endpoint) {
        String withoutScheme = endpoint.replaceFirst("^[a-zA-Z]+://", "");
        int slash = withoutScheme.indexOf('/');
        return slash < 0 ? withoutScheme : withoutScheme.substring(0, slash);
    }

    @GetMapping("/{room}")
    public List<Map<String, Object>> list(@PathVariable String room,
            @RequestParam(defaultValue = "" + DEFAULT_LIMIT) int limit,
            @RequestParam(defaultValue = "0") int offset) {
        return store()
                .forRoom(room, Pages.limit(limit, DEFAULT_LIMIT, MAX_LIMIT), Pages.offset(offset))
                .stream().map(RecordingLibraryController::describe).toList();
    }

    /**
     * A fresh playback URL. Minted per request rather than stored, so access
     * cannot outlive the moment it was asked for.
     */
    @GetMapping("/{room}/{id}/url")
    public Map<String, String> playbackUrl(@PathVariable String room, @PathVariable long id) {
        if (bucket.isBlank() || accessKey.isBlank()) {
            throw new ResponseStatusException(HttpStatus.NOT_FOUND, "recording storage is not configured");
        }
        RecordingEntity recording = store().byId(id)
                .filter(r -> r.getRoom().equals(room))
                .orElseThrow(() -> new ResponseStatusException(HttpStatus.NOT_FOUND, "no such recording"));

        // Signed against the object store's own host and path, because that is
        // what it will verify. The browser sends this to nginx under a prefix;
        // nginx strips the prefix and rewrites Host to the same value, so the
        // request the store receives is byte-for-byte the one that was signed.
        S3Presigner presigner = new S3Presigner(accessKey, secretKey, "us-east-1");
        String signed = presigner.presignGet("http", storeHost, bucket,
                recording.getObjectKey(), PLAYBACK_TTL, Instant.now());
        String pathAndQuery = signed.substring(signed.indexOf(storeHost) + storeHost.length());
        return Map.of(
                "url", publicPrefix + pathAndQuery,
                "expiresInSeconds", String.valueOf(PLAYBACK_TTL.toSeconds()));
    }

    /**
     * Deletes a recording: its object first, then its row, with an audit event
     * naming whoever asked.
     *
     * <p>Retention answers "everything ages out"; this answers "delete <em>that</em>
     * one", which is the request a person actually makes. It is irreversible by
     * design — the point is that the file stops existing.
     *
     * <p><strong>Host-gated when the room can say who its host is.</strong> Since
     * the signaling handshake binds each peer to its authenticated subject, the
     * room's host is now a person rather than just a peer id, and this endpoint
     * can require that person. When the room is empty (nobody to host it) or the
     * deployment has no identity provider (nobody to be), there is no such
     * subject and the endpoint falls back to the API's ordinary protection —
     * with attribution on the event either way. Gating on something the caller
     * supplies would only look like authorization.
     */
    @DeleteMapping("/{room}/{id}")
    public Map<String, Object> delete(@PathVariable String room, @PathVariable long id) {
        // Authorization first, deliberately: a 404 from the lookup would tell a
        // caller who may not delete whether the recording exists at all.
        authorization.requireHostIfKnown(room, "delete a room's recordings");
        RecordingEntity recording = store().byId(id)
                .filter(r -> r.getRoom().equals(room))
                .orElseThrow(() -> new ResponseStatusException(HttpStatus.NOT_FOUND, "no such recording"));
        if (!store().delete(recording, "manual", authorization.caller())) {
            throw new ResponseStatusException(HttpStatus.BAD_GATEWAY,
                    "the recording's object could not be removed; nothing was deleted");
        }
        return Map.of("id", id, "deleted", true);
    }



    private RecordingStore store() {
        RecordingStore store = recordings.getIfAvailable();
        if (store == null) {
            throw new ResponseStatusException(HttpStatus.NOT_FOUND,
                    "recordings require the postgres profile");
        }
        return store;
    }

    private static Map<String, Object> describe(RecordingEntity recording) {
        Map<String, Object> out = new HashMap<>();
        out.put("id", recording.getId());
        out.put("room", recording.getRoom());
        out.put("sizeBytes", recording.getSizeBytes());
        out.put("durationMs", recording.getDurationMs());
        out.put("endedAt", recording.getEndedAt().toString());
        if (recording.getStartedAt() != null) {
            out.put("startedAt", recording.getStartedAt().toString());
        }
        return out;
    }
}
