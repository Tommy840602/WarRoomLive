package com.warroomlive.web;

import com.warroomlive.attachments.AttachmentEntity;
import com.warroomlive.attachments.AttachmentStore;
import com.warroomlive.recordings.ObjectStore;
import com.warroomlive.signaling.SignalMessage;
import com.warroomlive.signaling.SignalingHandler;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.springframework.beans.factory.ObjectProvider;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.http.HttpStatus;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.server.ResponseStatusException;

import java.time.Duration;
import java.util.HashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.UUID;

/**
 * Files shared into a room.
 *
 * <p>A room with video, chat, notes and a whiteboard still had no way to hand
 * someone a document. This adds one, along the path recordings already proved:
 * the browser uploads <em>straight to the object store</em> through a presigned
 * PUT and downloads through a presigned GET, so a file's bytes never pass
 * through this server and the store's credentials never reach a browser.
 *
 * <p>Upload is two steps because the two facts arrive at different times. The
 * server signs a URL for a key it chose; the browser uploads; the browser then
 * confirms, and only then is a row written. A row without an object would be a
 * broken download sitting in the list, while an object without a row is merely
 * invisible and gets swept by retention — so the row goes last.
 *
 * <p>The declared size is checked before signing and the <em>stored</em> size is
 * checked at confirmation, because a presigned PUT cannot enforce a limit by
 * itself: without the second check the cap would be a suggestion.
 */
@RestController
@RequestMapping("/api/attachments")
public class AttachmentController {

    /** Long enough to upload a large file on a poor connection. */
    private static final Duration UPLOAD_TTL = Duration.ofMinutes(15);
    /** Short — a download starts immediately once the user clicks. */
    private static final Duration DOWNLOAD_TTL = Duration.ofMinutes(10);
    private static final int DEFAULT_LIMIT = 50;
    private static final int MAX_LIMIT = 200;

    private final ObjectProvider<AttachmentStore> attachments;
    private final ObjectStore objects;
    private final RoomAuthorization authorization;
    private final SignalingHandler signaling;
    private final ObjectMapper mapper;
    private final String publicPrefix;
    private final long maxBytes;

    public AttachmentController(
            ObjectProvider<AttachmentStore> attachments,
            ObjectStore objects,
            RoomAuthorization authorization,
            SignalingHandler signaling,
            ObjectMapper mapper,
            @Value("${warroomlive.attachments.public-prefix:/objects}") String publicPrefix,
            @Value("${warroomlive.attachments.max-bytes:26214400}") long maxBytes) {
        this.attachments = attachments;
        this.objects = objects;
        this.authorization = authorization;
        this.signaling = signaling;
        this.mapper = mapper;
        this.publicPrefix = publicPrefix;
        this.maxBytes = maxBytes;
    }

    /** What the browser must know before it can upload. */
    public record UploadRequest(String filename, String contentType, long sizeBytes) {
    }

    /** What the browser reports once the upload finished. */
    public record ConfirmRequest(String objectKey, String filename, String contentType) {
    }

    /**
     * Signs an upload for a key this server chooses.
     *
     * <p>The key is server-chosen so it cannot collide, cannot escape its room's
     * prefix, and cannot carry a path from a filename the user picked.
     */
    @PostMapping("/{room}/upload-url")
    public Map<String, Object> uploadUrl(@PathVariable String room, @RequestBody UploadRequest request) {
        requireConfigured();
        if (request.filename() == null || request.filename().isBlank()) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "filename is required");
        }
        if (request.sizeBytes() > maxBytes) {
            throw new ResponseStatusException(HttpStatus.PAYLOAD_TOO_LARGE,
                    "files are limited to " + maxBytes + " bytes");
        }
        String objectKey = keyFor(room, request.filename());
        String signed = objects.presign("PUT", objectKey, UPLOAD_TTL);
        return Map.of(
                "objectKey", objectKey,
                "uploadUrl", publicPrefix + objects.pathAndQueryOf(signed),
                "maxBytes", maxBytes);
    }

    /**
     * Records a finished upload and tells the room about it.
     *
     * <p>The stored size is read back from the object store rather than taken
     * from the caller: it is the only number that is true, and it is what the
     * limit has to be enforced against.
     */
    @PostMapping("/{room}")
    public Map<String, Object> confirm(@PathVariable String room, @RequestBody ConfirmRequest request) {
        requireConfigured();
        String objectKey = request.objectKey() == null ? "" : request.objectKey();
        // A key from another room would let a caller list someone else's file
        // into this one. The prefix is this server's own, so checking it is enough.
        if (!objectKey.startsWith(roomPrefix(room))) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST,
                    "that object does not belong to this room");
        }
        long stored = objects.sizeOf(objectKey);
        if (stored < 0) {
            throw new ResponseStatusException(HttpStatus.NOT_FOUND,
                    "no uploaded object for that key");
        }
        if (stored > maxBytes) {
            // The upload got past the signed URL, so undo it rather than list it.
            objects.delete(objectKey);
            throw new ResponseStatusException(HttpStatus.PAYLOAD_TOO_LARGE,
                    "files are limited to " + maxBytes + " bytes");
        }
        AttachmentEntity saved = store().created(room, objectKey,
                trimmedName(request.filename()),
                request.contentType() == null || request.contentType().isBlank()
                        ? "application/octet-stream" : request.contentType(),
                stored, authorization.caller());
        announce(room, saved);
        return describe(saved);
    }

    /**
     * One page of a room's files. 404s when file sharing is not configured,
     * which is also how the client learns not to offer an upload control it
     * would only be able to fail.
     */
    @GetMapping("/{room}")
    public List<Map<String, Object>> list(@PathVariable String room,
            @RequestParam(defaultValue = "" + DEFAULT_LIMIT) int limit,
            @RequestParam(defaultValue = "0") int offset) {
        requireConfigured();
        return store()
                .forRoom(room, Pages.limit(limit, DEFAULT_LIMIT, MAX_LIMIT), Pages.offset(offset))
                .stream().map(AttachmentController::describe).toList();
    }

    /** A fresh download URL, minted per request so access cannot outlive the asking. */
    @GetMapping("/{room}/{id}/url")
    public Map<String, String> downloadUrl(@PathVariable String room, @PathVariable long id) {
        requireConfigured();
        AttachmentEntity attachment = find(room, id);
        String signed = objects.presign("GET", attachment.getObjectKey(), DOWNLOAD_TTL);
        return Map.of(
                "url", publicPrefix + objects.pathAndQueryOf(signed),
                "filename", attachment.getFilename(),
                "expiresInSeconds", String.valueOf(DOWNLOAD_TTL.toSeconds()));
    }

    /** Host-gated on the same terms as recording deletion. */
    @DeleteMapping("/{room}/{id}")
    public Map<String, Object> delete(@PathVariable String room, @PathVariable long id) {
        // Authorization before the lookup — see the recording library for why.
        authorization.requireHostIfKnown(room, "delete a room's files");
        AttachmentEntity attachment = find(room, id);
        if (!store().delete(attachment, "manual", authorization.caller())) {
            throw new ResponseStatusException(HttpStatus.BAD_GATEWAY,
                    "the file's object could not be removed; nothing was deleted");
        }
        return Map.of("id", id, "deleted", true);
    }

    /**
     * Tells everyone in the room that a file arrived, so their list refreshes
     * without polling. Nobody may be connected — uploading from a room you have
     * since left is legitimate — in which case this reaches no one and that is
     * the correct outcome.
     */
    private void announce(String room, AttachmentEntity attachment) {
        signaling.broadcastToRoom(room, new SignalMessage(
                SignalMessage.TYPE_ATTACHMENT, room, null, null,
                mapper.valueToTree(describe(attachment))));
    }

    /**
     * A key inside the room's prefix, unique, and carrying a sanitised copy of
     * the original name for anyone browsing the bucket directly.
     */
    private static String keyFor(String room, String filename) {
        String safe = filename.replaceAll("[^A-Za-z0-9._-]", "_");
        if (safe.length() > 80) {
            safe = safe.substring(safe.length() - 80);
        }
        return roomPrefix(room) + UUID.randomUUID() + "-" + safe.toLowerCase(Locale.ROOT);
    }

    private static String roomPrefix(String room) {
        return "attachments/" + room.replaceAll("[^A-Za-z0-9._-]", "_") + "/";
    }

    private static String trimmedName(String filename) {
        if (filename == null || filename.isBlank()) {
            return "file";
        }
        String trimmed = filename.trim();
        return trimmed.length() > 255 ? trimmed.substring(trimmed.length() - 255) : trimmed;
    }

    private AttachmentEntity find(String room, long id) {
        return store().byId(id)
                .filter(a -> a.getRoom().equals(room))
                .orElseThrow(() -> new ResponseStatusException(HttpStatus.NOT_FOUND, "no such file"));
    }

    private void requireConfigured() {
        if (!objects.configured()) {
            throw new ResponseStatusException(HttpStatus.NOT_FOUND, "file sharing is not configured");
        }
    }

    private AttachmentStore store() {
        AttachmentStore store = attachments.getIfAvailable();
        if (store == null) {
            throw new ResponseStatusException(HttpStatus.NOT_FOUND,
                    "file sharing requires the postgres profile");
        }
        return store;
    }



    private static Map<String, Object> describe(AttachmentEntity attachment) {
        Map<String, Object> out = new HashMap<>();
        out.put("id", attachment.getId());
        out.put("room", attachment.getRoom());
        out.put("filename", attachment.getFilename());
        out.put("contentType", attachment.getContentType());
        out.put("sizeBytes", attachment.getSizeBytes());
        out.put("uploadedBy", attachment.getUploadedBy());
        out.put("uploadedAt", attachment.getUploadedAt().toString());
        return out;
    }
}
