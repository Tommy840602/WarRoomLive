package com.warroomlive.web;

import com.warroomlive.meetings.MeetingEntity;
import com.warroomlive.meetings.MeetingExporter;
import com.warroomlive.meetings.MeetingStore;
import org.springframework.beans.factory.ObjectProvider;
import org.springframework.http.HttpHeaders;
import org.springframework.http.HttpStatus;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
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
 * A room's past meetings.
 *
 * <p>The rows have been written since the meeting domain landed and nothing has
 * ever read them, so a room could not answer "when did we last meet about this,
 * and for how long" about itself.
 *
 * <p>Read backwards, unlike the calendar: a history opens on what just
 * happened, and the room's first meeting is the one nobody scrolls to.
 *
 * <p>Not host-gated. It says when a room was busy and how many people were in
 * it — the same thing anyone who was there already knows — and the room's chat
 * history is replayed to any joiner anyway. Gating this while that is open
 * would be a lock on the quieter door.
 */
@RestController
@RequestMapping("/api/meetings")
public class MeetingController {

    private static final int DEFAULT_LIMIT = 50;
    private static final int MAX_LIMIT = 200;

    private final ObjectProvider<MeetingStore> meetings;
    private final ObjectProvider<MeetingExporter> exporter;

    public MeetingController(ObjectProvider<MeetingStore> meetings,
            ObjectProvider<MeetingExporter> exporter) {
        this.meetings = meetings;
        this.exporter = exporter;
    }

    @GetMapping("/{room}")
    public List<Map<String, Object>> list(@PathVariable String room,
            @RequestParam(defaultValue = "" + DEFAULT_LIMIT) int limit,
            @RequestParam(defaultValue = "0") int offset) {
        return store()
                .forRoom(room, Pages.limit(limit, DEFAULT_LIMIT, MAX_LIMIT), Pages.offset(offset))
                .stream().map(MeetingController::describe).toList();
    }

    /**
     * The meeting as one Markdown document: chat, agenda, notes, files, recordings.
     *
     * <p>Served as an attachment, because the thing people do with a meeting
     * record is keep it. Text rather than a download endpoint that mints links:
     * the whole point is that it survives being pasted somewhere else.
     */
    @GetMapping(value = "/{room}/{id}/export", produces = "text/markdown; charset=UTF-8")
    public ResponseEntity<String> export(@PathVariable String room, @PathVariable long id) {
        MeetingEntity meeting = store().byId(room, id)
                .orElseThrow(() -> new ResponseStatusException(HttpStatus.NOT_FOUND,
                        "no such meeting"));
        MeetingExporter export = exporter.getIfAvailable();
        if (export == null) {
            throw new ResponseStatusException(HttpStatus.NOT_FOUND,
                    "meeting export requires the postgres profile");
        }
        String body = export.export(meeting, endOf(meeting));
        // The room name is user-supplied and reaches a header, so it is reduced
        // to characters that cannot break out of the quoted filename.
        String safeRoom = room.replaceAll("[^A-Za-z0-9._-]", "-");
        String filename = safeRoom + "-" + id + ".md";
        return ResponseEntity.ok()
                .header(HttpHeaders.CONTENT_DISPOSITION, "attachment; filename=\"" + filename + "\"")
                .contentType(MediaType.parseMediaType("text/markdown; charset=UTF-8"))
                .body(body);
    }

    private MeetingStore store() {
        MeetingStore store = meetings.getIfAvailable();
        if (store == null) {
            throw new ResponseStatusException(HttpStatus.NOT_FOUND,
                    "meeting history requires the postgres profile");
        }
        return store;
    }

    static Map<String, Object> describe(MeetingEntity meeting) {
        Map<String, Object> out = new HashMap<>();
        out.put("id", meeting.id());
        out.put("room", meeting.room());
        out.put("startedAt", meeting.startedAt().toString());
        out.put("participantPeak", meeting.participantPeak());
        if (meeting.endedAt() != null) {
            out.put("endedAt", meeting.endedAt().toString());
            out.put("durationSeconds",
                    Duration.between(meeting.startedAt(), meeting.endedAt()).toSeconds());
        } else {
            // Still running, or the node died with people still in the room.
            // Either way the duration is not a fact yet, so it is absent rather
            // than measured against now and presented as one.
            out.put("live", true);
        }
        return out;
    }

    /** Shared with the export endpoint, which needs the same window. */
    static Instant endOf(MeetingEntity meeting) {
        return meeting.endedAt() == null ? Instant.now() : meeting.endedAt();
    }
}
