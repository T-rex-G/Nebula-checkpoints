package app;

import org.springframework.web.bind.annotation.*;
import org.springframework.security.access.prepost.PreAuthorize;
import java.security.Principal;

@RestController
public class InvoiceController {
  private InvoiceRepository invoices;
  @PreAuthorize("@invoiceSecurity.owns(#id, authentication)")
  @GetMapping("/invoices/{id}")
  public Invoice get(@PathVariable Long id) {
    return invoices.findById(id).orElseThrow();
  }
}
