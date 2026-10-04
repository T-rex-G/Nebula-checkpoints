package com.example;

import org.springframework.web.bind.annotation.*;

@RestController
public class PingController {
    @GetMapping("/ping")
    public String ping(@RequestParam String host) throws Exception {
        Process process = Runtime.getRuntime().exec("ping -c 1 " + host); // expect: SEC-011
        return new String(process.getInputStream().readAllBytes());
    }
}
