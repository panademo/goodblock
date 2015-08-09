import imp
import time
import unittest

# Try importing local settings.
try:
    imp.find_module('local_settings')
    import local_settings
    local_settings_found = True
except ImportError:
    local_settings_found = False

from selenium import webdriver
from selenium.webdriver.common.by import By
from selenium.webdriver.support.ui import WebDriverWait
from selenium.webdriver.common.keys import Keys
from selenium.webdriver.support import expected_conditions as EC
from selenium.webdriver.chrome.options import Options
from selenium.webdriver.common.action_chains import ActionChains

import helpers


# Returns the driver for the browser with Goodblock installed.
def get_goodblock_web_driver():
    chrome_options = Options()
    dist_path = './dist/build/goodblock.chromium'
    chrome_options.add_argument('load-extension=%s' % dist_path)
    if local_settings_found:
        # If the user specified a custom binary path, use it.
        google_chrome_binary_path = getattr(local_settings, 'GOOGLE_CHROME_BINARY_PATH', None)
        if google_chrome_binary_path:
            chrome_options._binary_location = google_chrome_binary_path
    return webdriver.Chrome(chrome_options=chrome_options)

def setUpModule():
    # Launch the browser and install Goodblock.
    # This is so we don't have to launch a browser and reinstall the extension
    # between every test.
    driver = get_goodblock_web_driver()

    # Set the driver for access in tests.
    global DRIVER
    DRIVER = driver

def tearDownModule():
    # Close the browser.
    DRIVER.quit()


class GoodblockIconHoverTestCase(unittest.TestCase):

    def setUp(self):
        self.driver = DRIVER

        # Open a page and wait for the Goodblock icon to appear.
        self.open_test_page()
        self.wait_for_goodblock_icon_img_load()
        self.wait_for_goodblock_icon_appearance()

    def open_test_page(self):
        # Then open the page.
        self.driver.get('localhost:8000/blank-goodblock.html')
        # Wait until the page loads.
        wait = WebDriverWait(self.driver, 5)
        wait.until(
            EC.presence_of_element_located((By.CSS_SELECTOR, '[data-test-elem="page-title"]'))
        )

    def wait_for_goodblock_icon_img_load(self):
        wait = WebDriverWait(self.driver, 10)
        wait.until(
            EC.presence_of_element_located((By.CSS_SELECTOR, 'img[data-goodblock-elem="icon-img"]'))
        )

    def wait_for_goodblock_icon_appearance(self):
        wait = WebDriverWait(self.driver, 10)
        wait.until(
            EC.element_to_be_clickable((By.CSS_SELECTOR, 'img[data-goodblock-elem="icon-img"]'))
        )

    def test_icon_hover(self):

        # Hover over the Goodblock icon.
        goodblock_icon = self.driver.find_element_by_css_selector('img[data-goodblock-elem="icon-img"]')
        actions = ActionChains(self.driver)
        actions.move_to_element(goodblock_icon)
        actions.perform()

        # Ensure the snooze button is visible and correctly formatted.
        wait = WebDriverWait(self.driver, 1)
        wait.until(
            EC.presence_of_element_located((By.CSS_SELECTOR, '[data-goodblock-elem="snooze-button"]'))
        )
        EC.visibility_of_element_located((By.CSS_SELECTOR, '[data-goodblock-elem="snooze-button"]'))
        snooze_button = self.driver.find_element_by_css_selector('[data-goodblock-elem="snooze-button"]')
        self.assertEqual(snooze_button.value_of_css_property('width'), '70px')
        self.assertEqual(snooze_button.value_of_css_property('height'), '65px')

        # Move mouse off the icon.
        actions.move_to_element(goodblock_icon).move_by_offset(200, 10).perform()

        # Ensure the snooze button isn't visible.
        wait = WebDriverWait(self.driver, 4)
        wait.until(
            EC.invisibility_of_element_located((By.CSS_SELECTOR, '[data-goodblock-elem="snooze-button"]'))
        )


class GoodblockSnoozeTestCase(unittest.TestCase):

    def setUp(self):
        self.driver = DRIVER

    def test_snooze(self):
        # Hover over the Goodblock icon.
        goodblock_icon = self.driver.find_element_by_css_selector('img[data-goodblock-elem="icon-img"]')
        actions = ActionChains(self.driver)
        actions.move_to_element(goodblock_icon).perform()

        # Wait for the snooze button to appear.
        wait = WebDriverWait(self.driver, 1)
        wait.until(
            EC.presence_of_element_located((By.CSS_SELECTOR, '[data-goodblock-elem="snooze-button"]'))
        )

        snooze_button = self.driver.find_element_by_css_selector('[data-goodblock-elem="snooze-button"]')
        snooze_button.click()

        # Wait for the snooze speech bubble to appear.
        wait = WebDriverWait(self.driver, 2)
        wait.until(
            EC.visibility_of_element_located((By.CSS_SELECTOR, '[data-goodblock-elem="speech-bubble"]'))
        )

        # Test the speech bubble
        speech_bubble = self.driver.find_element_by_css_selector('[data-goodblock-elem="speech-bubble"]')
        self.assertEqual(speech_bubble.text, "Ok, I'll come back later!")
        self.assertEqual(speech_bubble.size['width'], 100)
        self.assertEqual(speech_bubble.size['height'], 54)

        # Wait for the speech bubble to disappear.
        wait = WebDriverWait(self.driver, 7)
        wait.until(
            EC.invisibility_of_element_located((By.CSS_SELECTOR, '[data-goodblock-elem="speech-bubble"]'))
        )

        # Wait for the Goodblock icon to disappear.
        wait = WebDriverWait(self.driver, 5)
        wait.until(
            EC.invisibility_of_element_located((By.CSS_SELECTOR, '[data-goodblock-elem="icon"]'))
        )

        snooze_time = helpers.get_animation_times()['snooze']

        # Make sure the icon is still invisible right before waking up from snooze.
        time.sleep(snooze_time - 0.01)
        EC.invisibility_of_element_located((By.CSS_SELECTOR, '[data-goodblock-elem="icon"]'))

        # Wait for the Goodblock icon to reappear.
        wait = WebDriverWait(self.driver, 5)
        wait.until(
            EC.visibility_of_element_located((By.CSS_SELECTOR, '[data-goodblock-elem="icon"]'))
        )

