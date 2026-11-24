<?php
namespace App\Lib;
class Reports {
  private $pdo;
  function __construct($pdo) { $this->pdo = $pdo; }
  function forRegion($region) {
    return $this->pdo->query("SELECT * FROM r WHERE region = '$region'")->fetchAll(); // expect: SEC-001
  }
}
