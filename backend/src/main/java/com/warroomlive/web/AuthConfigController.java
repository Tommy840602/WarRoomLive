package com.warroomlive.web;

import org.springframework.beans.factory.annotation.Value;
import org.springframework.core.env.Environment;
import org.springframework.core.env.Profiles;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

import java.util.Map;

/**
 * Bootstrap endpoint the frontend calls before anything else: reports whether OIDC
 * login is required and, if so, which issuer/client to use. Always anonymous — it is
 * how an unauthenticated client learns that (and where) it must authenticate.
 */
@RestController
@RequestMapping("/api")
public class AuthConfigController {

    private final boolean enabled;
    private final String issuer;
    private final String clientId;

    public AuthConfigController(
            Environment environment,
            @Value("${warroomlive.auth.issuer:}") String issuer,
            @Value("${warroomlive.auth.client-id:}") String clientId) {
        this.enabled = environment.acceptsProfiles(Profiles.of("oidc"));
        this.issuer = issuer;
        this.clientId = clientId;
    }

    @GetMapping("/auth/config")
    public Map<String, Object> config() {
        return Map.of("enabled", enabled, "issuer", issuer, "clientId", clientId);
    }
}
