package com.warroomlive.web;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.warroomlive.agenda.TodoEntity;
import com.warroomlive.agenda.TodoStore;
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
import java.time.format.DateTimeParseException;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

/**
 * A room's shared to-do list.
 *
 * <p>Kept in the database rather than in the room's Yjs document, alongside the
 * notes and the whiteboard, because a task is a durable business record and not
 * collaborative text: it has an owner, a due date and a completion, people ask
 * it questions ("what is still open"), and it outlives the meeting that created
 * it. A CRDT cannot be queried, cannot be validated, and cannot reach the event
 * backbone.
 *
 * <p>Adding and completing are open to anyone in the room — a shared list that
 * only one person may tick off is not shared. Deleting is host-gated, like every
 * other destructive action here.
 */
@RestController
@RequestMapping("/api/todos")
public class TodoController {

    private static final int DEFAULT_LIMIT = 50;
    private static final int MAX_LIMIT = 200;
    private static final int MAX_TEXT = 1000;

    private final ObjectProvider<TodoStore> todos;
    private final SignalingHandler signaling;
    private final RoomAuthorization authorization;
    private final ObjectMapper mapper;

    public TodoController(ObjectProvider<TodoStore> todos, SignalingHandler signaling,
            RoomAuthorization authorization, ObjectMapper mapper) {
        this.todos = todos;
        this.signaling = signaling;
        this.authorization = authorization;
        this.mapper = mapper;
    }

    public record CreateRequest(String text, String assignee, String dueAt) {
    }

    /**
     * Every field optional: a PATCH says what changed, not what everything is.
     *
     * <p>{@code triage} carries {@code "NOW"}, {@code "LATER"}, {@code "DONE"} or
     * {@code "auto"}; DONE becomes a completion rather than a stored word, for
     * the reason in {@link com.warroomlive.agenda.Triage}.
     */
    public record UpdateRequest(String text, String assignee, String dueAt, Boolean done,
            String triage) {
    }

    @GetMapping("/{room}")
    public List<Map<String, Object>> list(@PathVariable String room,
            @RequestParam(defaultValue = "" + DEFAULT_LIMIT) int limit,
            @RequestParam(defaultValue = "0") int offset) {
        return store()
                .forRoom(room, Pages.limit(limit, DEFAULT_LIMIT, MAX_LIMIT), Pages.offset(offset))
                .stream().map(TodoController::describe).toList();
    }

    @PostMapping("/{room}")
    public Map<String, Object> create(@PathVariable String room, @RequestBody CreateRequest request) {
        String text = requireText(request.text());
        TodoEntity saved = store().create(room, text, trimToNull(request.assignee()),
                parseInstant(request.dueAt(), "dueAt"), authorization.caller());
        announce(room);
        return describe(saved);
    }

    /**
     * Applies a partial change.
     *
     * <p>Completion and content are one request because the client sends one
     * intent. The store treats a repeated completion as a no-op, so a second
     * click cannot rewrite who finished the item.
     */
    @PatchMapping("/{room}/{id}")
    public Map<String, Object> update(@PathVariable String room, @PathVariable long id,
            @RequestBody UpdateRequest request) {
        String actor = authorization.caller();
        TodoEntity current = store().byId(room, id)
                .orElseThrow(() -> new ResponseStatusException(HttpStatus.NOT_FOUND, "no such item"));

        // Parsed before anything is written, so a bad triage does not leave the
        // edit half-applied.
        Triage triage = parseTriage(request.triage());

        TodoEntity updated = current;
        if (request.text() != null || request.assignee() != null || request.dueAt() != null) {
            String text = request.text() == null ? current.getText() : requireText(request.text());
            String assignee = request.assignee() == null
                    ? current.getAssignee() : trimToNull(request.assignee());
            Instant dueAt = request.dueAt() == null
                    ? current.getDueAt() : parseInstant(request.dueAt(), "dueAt");
            updated = store().edit(room, id, text, assignee, dueAt, actor).orElse(current);
        }
        updated = applyTriage(room, id, request.done(), request.triage(), triage, updated, actor);
        announce(room);
        return describe(updated);
    }

    /**
     * Applies completion and triage, which are the same request seen twice.
     *
     * <p>{@code triage: "DONE"} is turned into a completion rather than stored:
     * "done" is a fact about the work, with a time and an author, and writing the
     * word into the triage column as well would give the dashboard two copies to
     * disagree over. Anything else is filed as an opinion, and {@code "auto"}
     * hands the item back to the clock.
     *
     * <p>Marking a finished item NOW or LATER also reopens it, because that is
     * plainly what someone means by moving it back onto the board.
     */
    private TodoEntity applyTriage(String room, long id, Boolean done, String rawTriage,
            Triage triage, TodoEntity fallback, String actor) {
        TodoEntity out = fallback;
        boolean wantsDone = "DONE".equalsIgnoreCase(rawTriage);
        if (done != null || wantsDone) {
            boolean target = wantsDone || Boolean.TRUE.equals(done);
            out = store().setDone(room, id, target, actor).orElse(out);
        } else if (rawTriage != null && out.isDone()) {
            out = store().setDone(room, id, false, actor).orElse(out);
        }
        if (rawTriage != null && !wantsDone) {
            out = store().setTriage(room, id, triage).orElse(out);
        }
        return out;
    }

    @DeleteMapping("/{room}/{id}")
    public Map<String, Object> delete(@PathVariable String room, @PathVariable long id) {
        authorization.requireHostIfKnown(room, "delete a room's to-do items");
        if (!store().delete(room, id, authorization.caller())) {
            throw new ResponseStatusException(HttpStatus.NOT_FOUND, "no such item");
        }
        announce(room);
        return Map.of("id", id, "deleted", true);
    }

    /** Tells the room its list changed, so open panels refresh without polling. */
    private void announce(String room) {
        signaling.broadcastToRoom(room, new SignalMessage(
                SignalMessage.TYPE_AGENDA, room, null, null,
                mapper.valueToTree(Map.of("kind", "todo"))));
    }

    private static String requireText(String text) {
        String trimmed = text == null ? "" : text.trim();
        if (trimmed.isEmpty()) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "text is required");
        }
        if (trimmed.length() > MAX_TEXT) {
            // Refused, never truncated — the sender must know it did not save.
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST,
                    "text is limited to " + MAX_TEXT + " characters");
        }
        return trimmed;
    }

    private static String trimToNull(String value) {
        if (value == null) {
            return null;
        }
        String trimmed = value.trim();
        return trimmed.isEmpty() ? null : trimmed;
    }

    /**
     * Parses an ISO-8601 instant, or null for an explicit clear.
     *
     * <p>A bad date is refused rather than dropped: silently storing "no due
     * date" for something the user did set is worse than an error.
     */
    static Instant parseInstant(String value, String field) {
        if (value == null || value.isBlank()) {
            return null;
        }
        try {
            return Instant.parse(value);
        } catch (DateTimeParseException e) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST,
                    field + " must be an ISO-8601 instant, e.g. 2026-08-07T09:00:00Z");
        }
    }

    /**
     * Parses a triage word, or null for "let the clock decide again".
     *
     * <p>DONE also maps to null here: it is never stored, so the caller handles
     * it as a completion and this returns nothing to file. A word we do not know
     * is a caller bug, not an instruction to guess.
     */
    static Triage parseTriage(String value) {
        if (value == null || value.equalsIgnoreCase("DONE")) {
            return null;
        }
        try {
            return Triage.parse(value);
        } catch (IllegalArgumentException e) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST,
                    "triage must be NOW, LATER, DONE or auto");
        }
    }

    private TodoStore store() {
        TodoStore store = todos.getIfAvailable();
        if (store == null) {
            throw new ResponseStatusException(HttpStatus.NOT_FOUND,
                    "the shared to-do list requires the postgres profile");
        }
        return store;
    }

    private static Map<String, Object> describe(TodoEntity todo) {
        Map<String, Object> out = new HashMap<>();
        out.put("id", todo.getId());
        out.put("room", todo.getRoom());
        out.put("text", todo.getText());
        out.put("done", todo.isDone());
        out.put("createdBy", todo.getCreatedBy());
        out.put("createdAt", todo.getCreatedAt().toString());
        if (todo.getAssignee() != null) {
            out.put("assignee", todo.getAssignee());
        }
        if (todo.getDueAt() != null) {
            out.put("dueAt", todo.getDueAt().toString());
        }
        // Absent rather than null when nobody has overruled the clock: the
        // dashboard's rule is "no stored triage means work it out from the
        // time", and an explicit null in the payload invites the opposite.
        if (todo.getTriage() != null) {
            out.put("triage", todo.getTriage().name());
        }
        if (todo.getCompletedAt() != null) {
            out.put("completedAt", todo.getCompletedAt().toString());
            out.put("completedBy", todo.getCompletedBy());
        }
        return out;
    }
}
