package com.warroomlive.transcript;

import com.warroomlive.events.OutboxRecorder;
import org.springframework.beans.factory.ObjectProvider;
import org.springframework.context.annotation.Profile;
import org.springframework.stereotype.Component;
import org.springframework.transaction.annotation.Transactional;

import java.util.Map;
import java.util.Optional;

/**
 * Where a meeting's summary is kept. Postgres profile only, like the rest of the
 * meeting domain.
 */
@Component
@Profile("postgres")
public class SummaryStore {

    private final MeetingSummaryJpaRepository repository;
    private final ObjectProvider<OutboxRecorder> outbox;

    public SummaryStore(MeetingSummaryJpaRepository repository,
            ObjectProvider<OutboxRecorder> outbox) {
        this.repository = repository;
        this.outbox = outbox;
    }

    @Transactional(readOnly = true)
    public Optional<MeetingSummaryEntity> find(String room, long meetingId) {
        return repository.findByMeetingId(meetingId)
                .filter(summary -> summary.getRoom().equals(room));
    }

    /**
     * Stores a summary, replacing any earlier one for the same meeting.
     *
     * <p>The row and its event commit together, the same rule every aggregate
     * here follows: a consumer that heard {@code meeting.summary.created} and
     * then could not read the summary would be reacting to something that never
     * happened.
     */
    @Transactional
    public MeetingSummaryEntity save(long meetingId, String room, String model, String summaryMd,
            int lineCount) {
        MeetingSummaryEntity summary = repository.findByMeetingId(meetingId)
                .map(existing -> {
                    existing.replace(summaryMd, model, lineCount);
                    return existing;
                })
                .orElseGet(() ->
                        new MeetingSummaryEntity(meetingId, room, model, summaryMd, lineCount));
        MeetingSummaryEntity saved = repository.save(summary);
        outbox.ifAvailable(recorder -> recorder.record(
                "meeting.summary.created", "meeting", String.valueOf(meetingId),
                Map.of("room", room,
                        "model", model,
                        "lineCount", lineCount)));
        return saved;
    }
}
