<?php
class Reports {
  private $pdo;
  function __construct($pdo) { $this->pdo = $pdo; }
  function forRegion($region) {
    $s = $this->pdo->prepare('SELECT * FROM r WHERE region = ?');
    $s->execute([$region]);
    return $s->fetchAll();
  }
}
