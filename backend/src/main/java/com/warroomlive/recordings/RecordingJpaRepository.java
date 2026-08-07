package com.warroomlive.recordings;

import org.springframework.data.jpa.repository.JpaRepository;

import java.util.List;
import java.util.Optional;

public interface RecordingJpaRepository extends JpaRepository<RecordingEntity, Long> {

    List<RecordingEntity> findByRoomOrderByEndedAtDesc(String room);

    Optional<RecordingEntity> findByEgressId(String egressId);
}
