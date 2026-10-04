package com.example;

import org.springframework.web.bind.annotation.*;

@RestController
public class UploadController extends UploadBase {
    @GetMapping("/uploads")
    public boolean exists(@RequestParam("file") String name) {
        return super.target(name).exists();
    }
}
