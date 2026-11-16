<?php
function run_query($sql) {
  global $db;
  return mysqli_query($db, $sql); // expect: SEC-001
}
