package com.warroomlive.meetings;

import com.warroomlive.events.OutboxRecorder;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.ObjectProvider;
import org.springframework.context.annotation.Profile;
import org.springframework.stereotype.Component;
import org.springframework.transaction.annotation.Transactional;

import java.time.Duration;
import java.time.Instant;
import java.util.Map;

/**
 * Tracks meeting lifecycle from cluster-accurate membership counts supplied by
 * the signaling layer: the join that takes a room 0→1 starts a meeting, the
 * leave that takes it →0 ends it. Meeting rows and their events commit in one
 * transaction ({@code meeting.started} / {@code meeting.ended}; events only
 * under the kafka profile). Postgres profile only — the zero-dependency default
 * simply doesn't track meetings.
 */
@Component
@Profile("postgres")
public class MeetingTracker {

    private static final Logger log = LoggerFactory.getLogger(MeetingTracker.class);

    private final MeetingJpaRepository meetings;
    private final ObjectProvider<OutboxRecorder> outbox;

    public MeetingTracker(MeetingJpaRepository meetings, ObjectProvider<OutboxRecorder> outbox) {
        this.meetings = meetings;
        this.outbox = outbox;
    }

    /** Called after a successful join with the room's new cluster-wide size. */
    @Transactional
    public void participantJoined(String room, int memberCount) {
        if (memberCount == 1) {
            MeetingEntity meeting = meetings.save(new MeetingEntity(room));
            log.info("Meeting {} started in room {}", meeting.id(), room);
            outbox.ifAvailable(recorder -> recorder.record(
                    "meeting.started", "meeting", String.valueOf(meeting.id()),
                    Map.of("room", room)));
            return;
        }
        meetings.findFirstByRoomAndEndedAtIsNullOrderByIdDesc(room).ifPresent(meeting -> {
            meeting.observeCount(memberCount);
            meetings.save(meeting);
        });
    }

    /** Called after a leave/disconnect with the room's remaining cluster-wide size. */
    @Transactional
    public void participantLeft(String room, int remaining) {
        if (remaining > 0) {
            return;
        }
        meetings.findFirstByRoomAndEndedAtIsNullOrderByIdDesc(room).ifPresent(meeting -> {
            meeting.end();
            meetings.save(meeting);
            long seconds = Duration.between(meeting.startedAt(),
                    meeting.endedAt() != null ? meeting.endedAt() : Instant.now()).toSeconds();
            log.info("Meeting {} in room {} ended after {}s (peak {})",
                    meeting.id(), room, seconds, meeting.participantPeak());
            outbox.ifAvailable(recorder -> recorder.record(
                    "meeting.ended", "meeting", String.valueOf(meeting.id()),
                    Map.of("room", room,
                            "durationSeconds", seconds,
                            "participantPeak", meeting.participantPeak())));
        });
    }
}
