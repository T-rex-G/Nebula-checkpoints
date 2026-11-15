<?php
$name = basename($_GET['file']);
readfile('/srv/uploads/' . $name);
