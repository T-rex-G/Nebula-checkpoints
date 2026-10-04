package com.example;

import java.io.StringReader;
import javax.xml.parsers.DocumentBuilder;
import javax.xml.parsers.DocumentBuilderFactory;
import org.springframework.web.bind.annotation.*;
import org.xml.sax.InputSource;

@RestController
public class ImportController {
    @PostMapping("/import")
    public String importFeed(@RequestBody String xml) throws Exception {
        DocumentBuilder builder = DocumentBuilderFactory.newInstance().newDocumentBuilder();
        return builder.parse(new InputSource(new StringReader(xml))).getDocumentElement().getNodeName(); // expect: SEC-034
    }
}
