package com.example;

import org.springframework.web.bind.annotation.*;
import org.springframework.web.client.RestTemplate;

@RestController
public class PreviewController {
    private final RestTemplate restTemplate = new RestTemplate();

    @GetMapping("/preview")
    public String preview(@RequestParam String url) {
        return restTemplate.getForObject(url, String.class); // expect: SEC-021
    }
}
