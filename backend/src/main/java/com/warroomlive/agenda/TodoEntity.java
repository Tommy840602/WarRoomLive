package com.warroomlive.agenda;

import jakarta.persistence.Column;
import jakarta.persistence.Entity;
import jakarta.persistence.GeneratedValue;
import jakarta.persistence.GenerationType;
import jakarta.persistence.Id;
import jakarta.persistence.Table;

import java.time.Instant;

/**
 * One item on a room's shared to-do list.
 *
 * <p>Completion is stored as a time and an author rather than a boolean. "Done"
 * is the question people ask; "who closed it, and when" is the question they ask
 * next, and a flag cannot answer it.
 */
@Entity
@Table(name = "todos")
public class TodoEntity {

    @Id
    @GeneratedValue(strategy = GenerationType.IDENTITY)
    private Long id;

    @Column(nullable = false)
    private String room;

    @Column(nullable = false, length = 1000)
    private String text;

    /** Free text: the person a task belongs to is often not a user of this system. */
    @Column
    private String assignee;

    @Column(name = "due_at")
    private Instant dueAt;

    @Column(name = "created_by", nullable = false)
    private String createdBy;

    @Column(name = "created_at", nullable = false)
    private Instant createdAt;

    @Column(name = "completed_at")
    private Instant completedAt;

    @Column(name = "completed_by")
    private String completedBy;

    protected TodoEntity() {
    }

    public TodoEntity(String room, String text, String assignee, Instant dueAt, String createdBy) {
        this.room = room;
        this.text = text;
        this.assignee = assignee;
        this.dueAt = dueAt;
        this.createdBy = createdBy;
        this.createdAt = Instant.now();
    }

    /**
     * Marks the item done or undone.
     *
     * <p>Re-completing an already-done item keeps the original time and author:
     * a second click should not quietly rewrite who finished it.
     */
    public void setDone(boolean done, String actor) {
        if (!done) {
            this.completedAt = null;
            this.completedBy = null;
        } else if (this.completedAt == null) {
            this.completedAt = Instant.now();
            this.completedBy = actor;
        }
    }

    public void edit(String text, String assignee, Instant dueAt) {
        this.text = text;
        this.assignee = assignee;
        this.dueAt = dueAt;
    }

    public boolean isDone() {
        return completedAt != null;
    }

    public Long getId() {
        return id;
    }

    public String getRoom() {
        return room;
    }

    public String getText() {
        return text;
    }

    public String getAssignee() {
        return assignee;
    }

    public Instant getDueAt() {
        return dueAt;
    }

    public String getCreatedBy() {
        return createdBy;
    }

    public Instant getCreatedAt() {
        return createdAt;
    }

    public Instant getCompletedAt() {
        return completedAt;
    }

    public String getCompletedBy() {
        return completedBy;
    }
}
