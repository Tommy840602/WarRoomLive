package com.warroomlive.transcript;

import org.springframework.data.jpa.repository.JpaRepository;

import java.util.Optional;

public interface MeetingSummaryJpaRepository extends JpaRepository<MeetingSummaryEntity, Long> {

    Optional<MeetingSummaryEntity> findByMeetingId(long meetingId);
}
