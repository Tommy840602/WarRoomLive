package com.warroomlive.meetings;

import org.springframework.data.jpa.repository.JpaRepository;

import java.util.Optional;

public interface MeetingJpaRepository extends JpaRepository<MeetingEntity, Long> {

    Optional<MeetingEntity> findFirstByRoomAndEndedAtIsNullOrderByIdDesc(String room);
}
