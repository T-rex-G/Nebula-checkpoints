package com.example;

import org.springframework.web.bind.annotation.*;

@RestController
public class PingController {
    @GetMapping("/ping")
    public String ping(@RequestParam String host) throws Exception {
        Process process = new ProcessBuilder("ping", "-c", "1", host).start();
        return new String(process.getInputStream().readAllBytes());
    }
}
