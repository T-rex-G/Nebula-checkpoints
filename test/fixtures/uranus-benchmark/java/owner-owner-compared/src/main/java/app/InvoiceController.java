package app;

import org.springframework.web.bind.annotation.*;
import org.springframework.security.access.prepost.PreAuthorize;
import java.security.Principal;

@RestController
public class InvoiceController {
  private InvoiceRepository invoices;
  @GetMapping("/invoices/{id}")
  public Invoice get(@PathVariable Long id, Principal principal) {
    Invoice invoice = invoices.findById(id).orElseThrow();
    if (!invoice.getOwner().equals(principal.getName())) throw new ForbiddenException();
    return invoice;
  }
}
