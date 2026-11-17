package app;

import org.springframework.web.bind.annotation.*;
import org.springframework.security.access.prepost.PreAuthorize;
import java.security.Principal;

@RestController
public class InvoiceController {
  private InvoiceRepository invoices;
  @GetMapping("/invoices/{id}")
  public Invoice get(@PathVariable Long id, Principal principal) { // expect: ACC-002 to-confirm
    log.info("read by {}", principal.getName());
    return invoices.findById(id).orElseThrow();
  }
}
