package com.example;

import java.io.File;

public class UploadBase {
    protected File target(String name) {
        return new File("/srv/uploads/" + name); // expect: SEC-022
    }
}
