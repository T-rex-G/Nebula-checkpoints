package com.example;

import java.io.File;
import java.nio.file.Files;
import org.springframework.web.bind.annotation.*;

@RestController
public class FileController {
    @GetMapping("/files/{name}")
    public byte[] read(@PathVariable String name) throws Exception {
        return Files.readAllBytes(new File("/srv/files", name).toPath()); // expect: SEC-022
    }
}
