package com.warroomlive.web;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.warroomlive.agenda.CalendarEventEntity;
import com.warroomlive.agenda.CalendarStore;
import com.warroomlive.agenda.Triage;
import com.warroomlive.signaling.SignalMessage;
import com.warroomlive.signaling.SignalingHandler;
import org.springframework.beans.factory.ObjectProvider;
import org.springframework.http.HttpStatus;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PatchMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.server.ResponseStatusException;

import java.time.Instant;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

/**
 * A room's shared calendar.
 *
 * <p>Read forwards from a point in time — the default is now, so the list opens
 * on what is coming rather than on whatever happened first in the room's
 * history. Reading the past is the deliberate act, by passing an earlier
 * {@code from}.
 *
 * <p>Times are instants throughout. A cross-department room is exactly the case
 * where two people read the same entry from different time zones, and a naive
 * timestamp is what makes them show up an hour apart.
 */
@RestController
@RequestMapping("/api/calendar")
public class CalendarController {

    private static final int DEFAULT_LIMIT = 50;
    private static final int MAX_LIMIT = 200;
    private static final int MAX_TITLE = 255;
    private static final int MAX_DESCRIPTION = 2000;

    private final ObjectProvider<CalendarStore> calendar;
    private final SignalingHandler signaling;
    private final RoomAuthorization authorization;
    private final ObjectMapper mapper;

    public CalendarController(ObjectProvider<CalendarStore> calendar, SignalingHandler signaling,
            RoomAuthorization authorization, ObjectMapper mapper) {
        this.calendar = calendar;
        this.signaling = signaling;
        this.authorization = authorization;
        this.mapper = mapper;
    }

    public record CreateRequest(String title, String description, String startsAt, String endsAt,
            String assignee) {
    }

    /**
     * Every field optional: a PATCH says what changed, not what everything is.
     *
     * <p>{@code triage} carries {@code "NOW"}, {@code "LATER"}, {@code "DONE"} or
     * {@code "auto"} — see {@link #applyTriage}.
     */
    public record UpdateRequest(String title, String description, String startsAt, String endsAt,
            String assignee, Boolean done, String triage) {
    }

    @GetMapping("/{room}")
    public List<Map<String, Object>> list(@PathVariable String room,
            @RequestParam(required = false) String from,
            @RequestParam(defaultValue = "" + DEFAULT_LIMIT) int limit,
            @RequestParam(defaultValue = "0") int offset) {
        Instant since = from == null || from.isBlank()
                ? Instant.now() : TodoController.parseInstant(from, "from");
        return store()
                .forRoom(room, since,
                        Pages.limit(limit, DEFAULT_LIMIT, MAX_LIMIT), Pages.offset(offset))
                .stream().map(CalendarController::describe).toList();
    }

    @PostMapping("/{room}")
    public Map<String, Object> create(@PathVariable String room, @RequestBody CreateRequest request) {
        String title = require(request.title(), MAX_TITLE, "title");
        Instant startsAt = TodoController.parseInstant(request.startsAt(), "startsAt");
        if (startsAt == null) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "startsAt is required");
        }
        Instant endsAt = TodoController.parseInstant(request.endsAt(), "endsAt");
        requireOrder(startsAt, endsAt);

        CalendarEventEntity saved = store().create(room, title,
                bounded(request.description(), MAX_DESCRIPTION, "description"),
                startsAt, endsAt, trimToNull(request.assignee()), authorization.caller());
        announce(room);
        return describe(saved);
    }

    @PatchMapping("/{room}/{id}")
    public Map<String, Object> update(@PathVariable String room, @PathVariable long id,
            @RequestBody UpdateRequest request) {
        CalendarEventEntity current = store().byId(room, id)
                .orElseThrow(() -> new ResponseStatusException(HttpStatus.NOT_FOUND, "no such event"));

        // Parsed before anything is written, so a bad triage does not leave the
        // edit half-applied.
        Triage triage = TodoController.parseTriage(request.triage());

        String title = request.title() == null
                ? current.getTitle() : require(request.title(), MAX_TITLE, "title");
        String description = request.description() == null
                ? current.getDescription()
                : bounded(request.description(), MAX_DESCRIPTION, "description");
        Instant startsAt = request.startsAt() == null
                ? current.getStartsAt() : TodoController.parseInstant(request.startsAt(), "startsAt");
        if (startsAt == null) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "startsAt cannot be cleared");
        }
        Instant endsAt = request.endsAt() == null
                ? current.getEndsAt() : TodoController.parseInstant(request.endsAt(), "endsAt");
        String assignee = request.assignee() == null
                ? current.getAssignee() : trimToNull(request.assignee());
        requireOrder(startsAt, endsAt);

        CalendarEventEntity updated = current;
        if (request.title() != null || request.description() != null
                || request.startsAt() != null || request.endsAt() != null
                || request.assignee() != null) {
            updated = store()
                    .edit(room, id, title, description, startsAt, endsAt, assignee,
                            authorization.caller())
                    .orElse(current);
        }
        updated = applyTriage(room, id, request.done(), request.triage(), triage, updated);
        announce(room);
        return describe(updated);
    }

    /**
     * Applies completion and triage, which are the same request seen twice.
     *
     * <p>{@code triage: "DONE"} is turned into a completion rather than stored:
     * "done" is a fact about the work, with a time and an author, and writing
     * the word into the triage column as well would give the dashboard two
     * copies to disagree over. Anything else is filed as an opinion, and
     * {@code "auto"} hands the entry back to the clock.
     *
     * <p>Marking an item NOW or LATER also reopens it, because that is plainly
     * what someone means by moving a finished thing back onto the board.
     */
    private CalendarEventEntity applyTriage(String room, long id, Boolean done, String rawTriage,
            Triage triage, CalendarEventEntity fallback) {
        CalendarEventEntity out = fallback;
        boolean wantsDone = "DONE".equalsIgnoreCase(rawTriage);
        if (done != null || wantsDone) {
            boolean target = wantsDone || Boolean.TRUE.equals(done);
            out = store().setDone(room, id, target, authorization.caller()).orElse(out);
        } else if (rawTriage != null && out.isDone()) {
            out = store().setDone(room, id, false, authorization.caller()).orElse(out);
        }
        if (rawTriage != null && !wantsDone) {
            out = store().setTriage(room, id, triage).orElse(out);
        }
        return out;
    }


    @DeleteMapping("/{room}/{id}")
    public Map<String, Object> delete(@PathVariable String room, @PathVariable long id) {
        authorization.requireHostIfKnown(room, "delete a room's calendar entries");
        if (!store().delete(room, id, authorization.caller())) {
            throw new ResponseStatusException(HttpStatus.NOT_FOUND, "no such event");
        }
        announce(room);
        return Map.of("id", id, "deleted", true);
    }

    private void announce(String room) {
        signaling.broadcastToRoom(room, new SignalMessage(
                SignalMessage.TYPE_AGENDA, room, null, null,
                mapper.valueToTree(Map.of("kind", "calendar"))));
    }

    /** An entry that ends before it starts is a typo, and it sorts nowhere sensible. */
    private static void requireOrder(Instant startsAt, Instant endsAt) {
        if (endsAt != null && endsAt.isBefore(startsAt)) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST,
                    "endsAt cannot be before startsAt");
        }
    }

    /** Blank means "nobody", not an owner whose name is the empty string. */
    private static String trimToNull(String value) {
        if (value == null) {
            return null;
        }
        String trimmed = value.trim();
        return trimmed.isEmpty() ? null : trimmed;
    }

    private static String require(String value, int max, String field) {
        String trimmed = value == null ? "" : value.trim();
        if (trimmed.isEmpty()) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, field + " is required");
        }
        return bounded(trimmed, max, field);
    }

    private static String bounded(String value, int max, String field) {
        String trimmed = value == null ? "" : value.trim();
        if (trimmed.length() > max) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST,
                    field + " is limited to " + max + " characters");
        }
        return trimmed;
    }

    private CalendarStore store() {
        CalendarStore store = calendar.getIfAvailable();
        if (store == null) {
            throw new ResponseStatusException(HttpStatus.NOT_FOUND,
                    "the shared calendar requires the postgres profile");
        }
        return store;
    }

    private static Map<String, Object> describe(CalendarEventEntity event) {
        Map<String, Object> out = new HashMap<>();
        out.put("id", event.getId());
        out.put("room", event.getRoom());
        out.put("title", event.getTitle());
        out.put("description", event.getDescription());
        out.put("startsAt", event.getStartsAt().toString());
        out.put("createdBy", event.getCreatedBy());
        out.put("createdAt", event.getCreatedAt().toString());
        out.put("done", event.isDone());
        if (event.getAssignee() != null) {
            out.put("assignee", event.getAssignee());
        }
        if (event.getEndsAt() != null) {
            out.put("endsAt", event.getEndsAt().toString());
        }
        // Absent rather than null when nobody has overruled the clock: the
        // dashboard's rule is "no stored triage means work it out from the
        // time", and an explicit null in the payload invites the opposite.
        if (event.getTriage() != null) {
            out.put("triage", event.getTriage().name());
        }
        if (event.getCompletedAt() != null) {
            out.put("completedAt", event.getCompletedAt().toString());
            out.put("completedBy", event.getCompletedBy());
        }
        return out;
    }
}
