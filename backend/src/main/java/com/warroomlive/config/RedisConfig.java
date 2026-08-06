package com.warroomlive.config;

import com.warroomlive.signaling.RedisBackplane;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.context.annotation.Profile;
import org.springframework.data.redis.connection.RedisConnectionFactory;
import org.springframework.data.redis.listener.ChannelTopic;
import org.springframework.data.redis.listener.RedisMessageListenerContainer;
import org.springframework.scheduling.annotation.EnableScheduling;

import java.nio.charset.StandardCharsets;

/**
 * Wires the {@code redis}-profile backplane: subscribes the node to the signal
 * channel and enables the heartbeat schedule. Absent in the default profile, so
 * no Redis connection is ever attempted there.
 */
@Configuration
@Profile("redis")
@EnableScheduling
public class RedisConfig {

    @Bean
    RedisMessageListenerContainer backplaneListener(
            RedisConnectionFactory connectionFactory, RedisBackplane backplane) {
        RedisMessageListenerContainer container = new RedisMessageListenerContainer();
        container.setConnectionFactory(connectionFactory);
        container.addMessageListener(
                (message, pattern) -> backplane.onMessage(new String(message.getBody(), StandardCharsets.UTF_8)),
                new ChannelTopic(RedisBackplane.CHANNEL));
        return container;
    }
}
