package com.warroomlive.agenda;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.warroomlive.signaling.SignalMessage;
import com.warroomlive.signaling.SignalingHandler;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.context.annotation.Profile;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Component;
import org.springframework.transaction.support.TransactionTemplate;

import java.time.Instant;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

/**
 * Tells a room when something on its agenda has come due.
 *
 * <p>Due times have existed since the agenda landed and nothing ever acted on
 * one: the time arrived, the row turned red, and if nobody had the panel open
 * nobody knew. A deadline that only exists while you are looking at it is a
 * deadline the tool is not keeping for you.
 *
 * <p><strong>Announced exactly once</strong>, via {@code reminded_at}. A
 * scheduler that remembered in memory what it had already said would repeat
 * everything after a restart and, with two nodes, say it all twice anyway. The
 * mark and the announcement commit together, so the room and the database
 * cannot disagree about whether it was said.
 *
 * <p>The announcement rides the signaling plane rather than the event backbone:
 * it is a nudge to people currently in the room, not a fact about the work.
 * Nobody in the room means nobody to nudge — the item is still marked, because
 * the alternative is announcing a week of deadlines to whoever opens the room
 * next.
 */
@Component
@Profile("postgres")
public class DueReminder {

    private static final Logger log = LoggerFactory.getLogger(DueReminder.class);

    /**
     * Per pass, per table. A room reopened after a long weekend has a backlog,
     * and the point is to surface what is due now rather than to replay it all.
     */
    private static final int BATCH = 50;

    private final TodoJpaRepository todos;
    private final CalendarEventJpaRepository calendar;
    private final SignalingHandler signaling;
    private final ObjectMapper mapper;
    private final TransactionTemplate tx;
    private final boolean enabled;

    public DueReminder(TodoJpaRepository todos, CalendarEventJpaRepository calendar,
            SignalingHandler signaling, ObjectMapper mapper, TransactionTemplate tx,
            @Value("${warroomlive.agenda.reminders-enabled:true}") boolean enabled) {
        this.todos = todos;
        this.calendar = calendar;
        this.signaling = signaling;
        this.mapper = mapper;
        this.tx = tx;
        this.enabled = enabled;
    }

    /**
     * A minute, matching the panel's own clock: a reminder that arrives well
     * after the row has already turned red is not telling anyone anything.
     */
    @Scheduled(fixedDelayString = "${warroomlive.agenda.reminder-interval-ms:60000}")
    public void sweep() {
        if (!enabled) {
            return;
        }
        try {
            announce();
        } catch (Exception e) {
            // A failed pass must not kill the schedule; the next minute retries.
            log.warn("Due-reminder sweep failed; will retry on the next pass", e);
        }
    }

    /**
     * One transaction per item, deliberately.
     *
     * <p>Batching them would make one unroutable room's failure roll back the
     * marks for every other room in the pass, and the next minute would then
     * announce all of them again.
     */
    int announce() {
        List<Due> due = new ArrayList<>();
        Instant now = Instant.now();
        for (TodoEntity t : todos.dueAndUnannounced(now, BATCH)) {
            due.add(new Due(t.getRoom(), "todo", t.getId(), t.getText(), t.getAssignee(),
                    t.getDueAt()));
        }
        for (CalendarEventEntity e : calendar.dueAndUnannounced(now, BATCH)) {
            due.add(new Due(e.getRoom(), "calendar", e.getId(), e.getTitle(), null,
                    e.getStartsAt()));
        }

        int announced = 0;
        for (Due item : due) {
            // The mark is what makes this idempotent, so it commits with the
            // broadcast rather than after it: a crash between the two would
            // otherwise tell the room twice.
            Boolean ok = tx.execute(status -> {
                if (item.kind().equals("todo")) {
                    todos.findById(item.id()).ifPresent(t -> {
                        t.markReminded();
                        todos.save(t);
                    });
                } else {
                    calendar.findById(item.id()).ifPresent(e -> {
                        e.markReminded();
                        calendar.save(e);
                    });
                }
                broadcast(item);
                return true;
            });
            if (Boolean.TRUE.equals(ok)) {
                announced++;
            }
        }
        if (announced > 0) {
            log.info("Announced {} due agenda item(s)", announced);
        }
        return announced;
    }

    private void broadcast(Due item) {
        Map<String, Object> payload = new HashMap<>();
        payload.put("kind", item.kind());
        payload.put("id", item.id());
        payload.put("text", item.text());
        payload.put("dueAt", item.dueAt().toString());
        if (item.assignee() != null) {
            payload.put("assignee", item.assignee());
        }
        signaling.broadcastToRoom(item.room(), new SignalMessage(
                SignalMessage.TYPE_AGENDA_DUE, item.room(), null, null,
                mapper.valueToTree(payload)));
    }

    private record Due(String room, String kind, Long id, String text, String assignee,
            Instant dueAt) {
    }
}
