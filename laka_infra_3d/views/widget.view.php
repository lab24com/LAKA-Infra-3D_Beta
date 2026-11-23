<?php declare(strict_types = 0);
/*
 * LAKA Infra 3D – gemelo digital de data center para Zabbix 7.0 – 8.0
 * © LAKA Soluciones Tecnológicas
 * Autor: Willian Tola
 * Licencia GPLv3
 *
 * Vista del widget: entrega los datos al JS, que dibuja la escena 3D.
 *
 * @var CView $this
 * @var array $data
 */

$view = new CWidgetView($data);

foreach ($data['vars'] as $name => $value) {
	$view->setVar($name, $value);
}

$view->show();
