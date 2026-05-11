package com.healix.compat;

import java.util.List;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RestController;

@RestController
public class InventoryController {
  @GetMapping("/api/inventory")
  public List<InventoryItem> listInventory() {
    return List.of(
      new InventoryItem("sku-100", "Surgical Mask Kit", 420),
      new InventoryItem("sku-101", "ICU Sensor Pack", 85)
    );
  }

  @GetMapping("/api/inventory/{sku}")
  public InventoryItem getInventory(@PathVariable String sku) {
    return new InventoryItem("sku-100", "Surgical Mask Kit", 420);
  }

  @PostMapping("/api/inventory")
  public InventoryItem createInventory(@RequestBody InventoryItem item) {
    return item;
  }
}
