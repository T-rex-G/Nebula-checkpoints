<?php
$name = urlencode($_GET['name']);
system('convert uploads/' . $name . ' out.png'); // expect: SEC-011
