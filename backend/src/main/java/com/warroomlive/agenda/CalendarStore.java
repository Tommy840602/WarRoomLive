package com.warroomlive.agenda;

import com.warroomlive.events.OutboxRecorder;
import org.springframework.beans.factory.ObjectProvider;
import org.springframework.context.annotation.Profile;
import org.springframework.data.domain.Limit;
import org.springframework.stereotype.Component;
import org.springframework.transaction.annotation.Transactional;

import java.time.Instant;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;

/**
 * A room's shared calendar. Same shape and the same guarantees as
 * {@link TodoStore}: every change commits with its event.
 */
@Component
@Profile("postgres")
public class CalendarStore {

    private final CalendarEventJpaRepository repository;
    private final ObjectProvider<OutboxRecorder> outbox;

    public CalendarStore(CalendarEventJpaRepository repository, ObjectProvider<OutboxRecorder> outbox) {
        this.repository = repository;
        this.outbox = outbox;
    }

    @Transactional
    public CalendarEventEntity create(String room, String title, String description,
            Instant startsAt, Instant endsAt, String actor) {
        CalendarEventEntity saved = repository.save(
                new CalendarEventEntity(room, title, description, startsAt, endsAt, actor));
        record("calendar.event.created", saved, actor);
        return saved;
    }

    @Transactional
    public Optional<CalendarEventEntity> edit(String room, long id, String title, String description,
            Instant startsAt, Instant endsAt, String actor) {
        return find(room, id).map(event -> {
            event.edit(title, description, startsAt, endsAt);
            repository.save(event);
            record("calendar.event.updated", event, actor);
            return event;
        });
    }

    @Transactional
    public boolean delete(String room, long id, String actor) {
        Optional<CalendarEventEntity> event = find(room, id);
        event.ifPresent(e -> {
            repository.deleteById(e.getId());
            record("calendar.event.deleted", e, actor);
        });
        return event.isPresent();
    }

    @Transactional(readOnly = true)
    public List<CalendarEventEntity> forRoom(String room, Instant from, int limit, int offset) {
        return repository.pageForRoom(room, from, limit, offset);
    }

    @Transactional(readOnly = true)
    public Optional<CalendarEventEntity> byId(String room, long id) {
        return find(room, id);
    }

    @Transactional(readOnly = true)
    public List<CalendarEventEntity> expiredBefore(Instant cutoff, int limit) {
        return repository.findByCreatedAtBeforeOrderByCreatedAtAsc(cutoff, Limit.of(limit));
    }

    @Transactional
    public void deleteAll(List<CalendarEventEntity> events) {
        repository.deleteAll(events);
    }

    private Optional<CalendarEventEntity> find(String room, long id) {
        return repository.findById(id).filter(event -> event.getRoom().equals(room));
    }

    private void record(String type, CalendarEventEntity event, String actor) {
        outbox.ifAvailable(recorder -> {
            Map<String, Object> payload = new HashMap<>();
            payload.put("eventId", event.getId());
            payload.put("title", event.getTitle());
            payload.put("startsAt", event.getStartsAt().toString());
            payload.put("actor", actor);
            recorder.record(type, "room", event.getRoom(), payload);
        });
    }
}
