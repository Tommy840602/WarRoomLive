package com.warroomlive.meetings;

import jakarta.persistence.Column;
import jakarta.persistence.Entity;
import jakarta.persistence.GeneratedValue;
import jakarta.persistence.GenerationType;
import jakarta.persistence.Id;
import jakarta.persistence.Table;

import java.time.Instant;

/** One occupancy episode of a room: first join opens it, last leave closes it. */
@Entity
@Table(name = "meetings")
public class MeetingEntity {

    @Id
    @GeneratedValue(strategy = GenerationType.IDENTITY)
    private Long id;

    @Column(nullable = false)
    private String room;

    @Column(name = "started_at", nullable = false)
    private Instant startedAt;

    @Column(name = "ended_at")
    private Instant endedAt;

    @Column(name = "participant_peak", nullable = false)
    private int participantPeak;

    protected MeetingEntity() {
    }

    MeetingEntity(String room) {
        this.room = room;
        this.startedAt = Instant.now();
        this.participantPeak = 1;
    }

    public Long id() {
        return id;
    }

    public String room() {
        return room;
    }

    public Instant startedAt() {
        return startedAt;
    }

    public int participantPeak() {
        return participantPeak;
    }

    void observeCount(int count) {
        if (count > participantPeak) {
            participantPeak = count;
        }
    }

    void end() {
        this.endedAt = Instant.now();
    }

    public Instant endedAt() {
        return endedAt;
    }
}
