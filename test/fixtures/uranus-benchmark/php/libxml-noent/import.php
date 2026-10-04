<?php
$document = new DOMDocument();
$document->loadXML(file_get_contents('php://input'), LIBXML_NOENT | LIBXML_DTDLOAD); // expect: SEC-034
echo htmlspecialchars($document->documentElement->nodeName);
