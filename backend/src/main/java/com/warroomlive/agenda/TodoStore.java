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
 * A room's shared to-do list.
 *
 * <p>Present only under the {@code postgres} profile, like the other durable
 * stores — the default profile excludes the JPA auto-configuration entirely.
 *
 * <p>Every change commits with its event, so the backbone and the list cannot
 * disagree about what a room agreed to do.
 */
@Component
@Profile("postgres")
public class TodoStore {

    private final TodoJpaRepository repository;
    private final ObjectProvider<OutboxRecorder> outbox;

    public TodoStore(TodoJpaRepository repository, ObjectProvider<OutboxRecorder> outbox) {
        this.repository = repository;
        this.outbox = outbox;
    }

    @Transactional
    public TodoEntity create(String room, String text, String assignee, Instant dueAt, String actor) {
        TodoEntity saved = repository.save(new TodoEntity(room, text, assignee, dueAt, actor));
        record("todo.created", saved, Map.of("text", text, "actor", actor));
        return saved;
    }

    @Transactional
    public Optional<TodoEntity> setDone(String room, long id, boolean done, String actor) {
        return find(room, id).map(todo -> {
            boolean was = todo.isDone();
            todo.setDone(done, actor);
            repository.save(todo);
            // Only a real transition is worth an event; a repeated click is not
            // news, and a backbone full of it is a backbone nobody reads.
            if (was != todo.isDone()) {
                record(done ? "todo.completed" : "todo.reopened", todo, Map.of("actor", actor));
            }
            return todo;
        });
    }

    @Transactional
    public Optional<TodoEntity> edit(String room, long id, String text, String assignee,
            Instant dueAt, String actor) {
        return find(room, id).map(todo -> {
            todo.edit(text, assignee, dueAt);
            repository.save(todo);
            record("todo.updated", todo, Map.of("text", text, "actor", actor));
            return todo;
        });
    }

    @Transactional
    public boolean delete(String room, long id, String actor) {
        Optional<TodoEntity> todo = find(room, id);
        todo.ifPresent(t -> {
            repository.deleteById(t.getId());
            record("todo.deleted", t, Map.of("text", t.getText(), "actor", actor));
        });
        return todo.isPresent();
    }

    @Transactional(readOnly = true)
    public List<TodoEntity> forRoom(String room, int limit, int offset) {
        return repository.pageForRoom(room, limit, offset);
    }

    @Transactional(readOnly = true)
    public Optional<TodoEntity> byId(String room, long id) {
        return find(room, id);
    }

    @Transactional(readOnly = true)
    public List<TodoEntity> expiredBefore(Instant cutoff, int limit) {
        return repository.findByCreatedAtBeforeOrderByCreatedAtAsc(cutoff, Limit.of(limit));
    }

    @Transactional
    public void deleteAll(List<TodoEntity> todos) {
        repository.deleteAll(todos);
    }

    private Optional<TodoEntity> find(String room, long id) {
        return repository.findById(id).filter(todo -> todo.getRoom().equals(room));
    }

    private void record(String type, TodoEntity todo, Map<String, Object> extra) {
        outbox.ifAvailable(recorder -> {
            Map<String, Object> payload = new HashMap<>(extra);
            payload.put("todoId", todo.getId());
            recorder.record(type, "room", todo.getRoom(), payload);
        });
    }
}
