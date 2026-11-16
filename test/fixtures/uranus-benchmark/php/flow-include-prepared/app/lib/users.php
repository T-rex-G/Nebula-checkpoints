<?php
function find_user($name) {
  global $pdo;
  $s = $pdo->prepare('SELECT * FROM u WHERE n = ?');
  $s->execute([$name]);
  return $s->fetchAll();
}
