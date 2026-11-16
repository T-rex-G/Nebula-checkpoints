<?php
require_once 'db.php';
function find_user($name) {
  return run_query("SELECT * FROM u WHERE n = '" . $name . "'");
}
