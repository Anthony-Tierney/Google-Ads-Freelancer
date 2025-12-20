// FAQ toggle function
function toggleFaq(button) {
    const faqItem = button.parentElement;
    const isActive = faqItem.classList.contains('active');
    // Close all FAQ items
    document.querySelectorAll('.faq-item').forEach(item => {
        item.classList.remove('active');
    });
    // If this item wasn't active, open it
    if (!isActive) {
        faqItem.classList.add('active');
    }
}

// FAQ Sub-Accordion toggle function
function toggleSubFaq(button) {
    const subItem = button.parentElement;
    if (subItem) {
        subItem.classList.toggle('active');
    }
}

// Case Study Accordion toggle function
function toggleCaseStudyAccordion(button) {
    const caseStudyItem = button.parentElement;
    const isActive = caseStudyItem.classList.contains('active');
    // Close all other case study items
    document.querySelectorAll('.case-studies-accordion .case-study-item').forEach(item => {
        if (item !== caseStudyItem) {
            item.classList.remove('active');
        }
    });
    // Toggle the clicked item
    caseStudyItem.classList.toggle('active');
}

// Case Study Sub-Accordion toggle function
function toggleCaseStudySubAccordion(button) {
    const subItem = button.parentElement;
    const isActive = subItem.classList.contains('active');
    // Close all sibling sub-items
    const parentContainer = subItem.parentElement;
    parentContainer.querySelectorAll('.case-study-sub-item').forEach(item => {
        if (item !== subItem) {
            item.classList.remove('active');
        }
    });
    // Toggle the clicked sub-item
    subItem.classList.toggle('active');
}

// --- Case Study Card Flip Function (Defined in global scope for onclick) ---
function flipCaseStudyCard(button) {
    // Disable flip effect on small screens to use modal instead
    if (window.innerWidth <= 768) {
        // If the user clicks the card/front face or the chevron button on mobile, open the modal instead
        const card = button.closest('[class^="case-study-card-"]');
        if (card) {
            handleMobileCaseStudyClick(card);
        }
        return; 
    }
    
    // Find the closest ancestor element that is a case study card container
    const card = button.closest('[class^="case-study-card-"]');
    if (card) {
        card.classList.toggle('flipped');
    }
}
// --- END: Case Study Card Flip Function ---

// --- START: MODAL FUNCTIONS (for mobile Case Study Fallback) ---
function openModal(contentHtml) {
    const modal = document.getElementById('caseStudyModal');
    const modalBody = document.getElementById('modalBody');
    if (modal && modalBody) {
        modalBody.innerHTML = contentHtml;
        modal.style.display = 'block';
    }
}

function closeModal() {
    const modal = document.getElementById('caseStudyModal');
    if (modal) {
        modal.style.display = 'none';
    }
}

// Global click handler to close modal when clicking outside
window.onclick = function(event) {
    const modal = document.getElementById('caseStudyModal');
    if (event.target === modal) {
        closeModal();
    }
}

function handleMobileCaseStudyClick(cardElement) {
    // 1. Get the content from the hidden .case-study-back
    const backContent = cardElement.querySelector('.case-study-back').innerHTML;
    
    // 2. Open the modal with that content
    openModal(backContent);
}
// --- END: MODAL FUNCTIONS ---

// Function to handle the desktop services carousel initialization
function initializeServicesCarousel() {
    const servicesSection = document.querySelector('.services-section');
    const servicesGrid = document.querySelector('.services-grid');
    const serviceCards = document.querySelectorAll('.services-grid > [class^="service-card-"]');
    
    // Check if carousel is already initialized (e.g., if elements have wrappers)
    if (!servicesGrid || servicesGrid.closest('.carousel-container-wrapper') || serviceCards.length === 0) return;

    // 1. Create the NEW main carousel container
    const carouselContainer = document.createElement('div');
    carouselContainer.className = 'carousel-container-wrapper';

    // Create and add the counter element
    const counterElement = document.createElement('div');
    counterElement.className = 'service-card-counter animate';
    carouselContainer.appendChild(counterElement); 

    // 2. Wrap the services grid in its existing wrapper
    const wrapper = document.createElement('div');
    wrapper.className = 'services-grid-wrapper';
    
    // 3. Put the grid wrapper inside the new main container
    carouselContainer.appendChild(wrapper);

    // 4. Put the grid inside its wrapper
    servicesGrid.parentNode.insertBefore(carouselContainer, servicesGrid);
    wrapper.appendChild(servicesGrid); 
    
    let currentIndex = 1;
    const totalSlides = serviceCards.length;
    
    serviceCards.forEach((card, index) => {
        if (index === currentIndex) {
            card.classList.add('service-card-active');
        }
    });

    // Create navigation controls
    const navContainer = document.createElement('div');
    navContainer.className = 'carousel-nav';
    
    const prevBtn = document.createElement('button');
    prevBtn.className = 'carousel-btn carousel-prev';
    prevBtn.innerHTML = '<i class="fas fa-chevron-left"></i>';
    prevBtn.setAttribute('aria-label', 'Previous services');
    
    const nextBtn = document.createElement('button');
    nextBtn.className = 'carousel-btn carousel-next';
    nextBtn.innerHTML = '<i class="fas fa-chevron-right"></i>';
    nextBtn.setAttribute('aria-label', 'Next services');
    
    navContainer.appendChild(prevBtn);
    navContainer.appendChild(nextBtn);

    carouselContainer.insertBefore(navContainer, wrapper);
    
    // Create indicators
    const indicatorsContainer = document.createElement('div');
    indicatorsContainer.className = 'carousel-indicators';
    
    for (let i = 0; i < totalSlides; i++) {
        const indicator = document.createElement('div');
        indicator.className = 'carousel-indicator';
        if (i === 1) indicator.classList.add('active');
        indicator.setAttribute('data-slide', i);
        indicator.setAttribute('aria-label', `Go to slide ${i + 1}`);
        indicatorsContainer.appendChild(indicator);
    }
    
    carouselContainer.parentNode.insertBefore(indicatorsContainer, carouselContainer.nextSibling);

    // New logic to handle clicking on any card
    serviceCards.forEach((card, index) => {
        card.classList.remove('animate'); 
        card.style.transform = '';

        card.addEventListener('click', () => {
            if (index !== currentIndex) {
                currentIndex = index;
                updateCarousel();
            }
        });
    });

    function updateCarousel() {
        if (serviceCards.length === 0) return;

        // 1. Get dimensions
        const cardWidth = serviceCards[0].offsetWidth;
        const wrapperWidth = wrapper.offsetWidth;
        const gap = 32; 

        // 2. Calculate the total offset to the *start* of the active card
        const offsetToCard = currentIndex * (cardWidth + gap);

        // 3. Calculate the offset needed to center *a* card
        const centerOffset = (wrapperWidth / 2) - (cardWidth / 2);

        // 4. The new transform is the centering offset - the offset to the active card
        const newTransform = centerOffset - offsetToCard;

        servicesGrid.style.transform = `translateX(${newTransform}px)`;

        // Update active classes (This is CRITICAL for scaling/fading)
        serviceCards.forEach((card, index) => {
            card.classList.toggle('service-card-active', index === currentIndex);
        });

        // Update buttons state
        prevBtn.disabled = currentIndex === 0;
        nextBtn.disabled = currentIndex >= totalSlides - 1; 
        
        // Update indicators
        indicatorsContainer.querySelectorAll('.carousel-indicator').forEach((indicator, index) => {
    indicator.classList.toggle('active', index === currentIndex);
        });

        // Update the counter text
        if (counterElement) {
            counterElement.textContent = `${currentIndex + 1} / ${totalSlides}`;
        }
    }
    
    // Navigation handlers
    prevBtn.addEventListener('click', () => {
        if (currentIndex > 0) {
            currentIndex--;
            updateCarousel();
        }
    });
    
    nextBtn.addEventListener('click', () => {
        if (currentIndex < totalSlides - 1) {
            currentIndex++;
            updateCarousel();
        }
    });
    
    // Indicator handlers
    document.querySelectorAll('.carousel-indicator').forEach(indicator => {
        indicator.addEventListener('click', (e) => {
            currentIndex = parseInt(e.target.getAttribute('data-slide'));
            updateCarousel();
        });
    });

    // Initial update
    updateCarousel();

    // Store the update function on the grid for external calls (e.g. resize)
    servicesGrid.updateCarousel = updateCarousel;
}

// Function to reset the DOM structure after resizing from desktop to mobile
function cleanupServicesCarousel() {
    const servicesGrid = document.querySelector('.services-grid');
    const carouselContainer = servicesGrid ? servicesGrid.closest('.carousel-container-wrapper') : null;
    const indicatorsContainer = carouselContainer ? carouselContainer.nextElementSibling : null;

    if (carouselContainer && servicesGrid) {
        // Move the services grid back out of the wrapper and carousel container
        carouselContainer.parentNode.insertBefore(servicesGrid, carouselContainer);
        
        // Remove the carousel container (which holds the wrapper, nav, and counter)
        carouselContainer.remove();
        
        // Remove the indicators
        if (indicatorsContainer && indicatorsContainer.classList.contains('carousel-indicators')) {
            indicatorsContainer.remove();
        }

        // Remove inline styles set by the carousel
        servicesGrid.style.transform = '';
        document.querySelectorAll('.services-grid > [class^="service-card-"]').forEach(card => {
            card.classList.remove('service-card-active');
            card.style.transform = '';
            card.style.opacity = '';
        });
    }
}

// --- NEW: Testimonials Carousel Functions (Native Scroll + Indicators) ---
function initializeTestimonialsCarousel() {
    const testimonialsGrid = document.querySelector('.testimonials-grid');
    const prevBtn = document.getElementById('testimonials-prev');
    const nextBtn = document.getElementById('testimonials-next');
    const indicatorsContainer = document.getElementById('testimonials-indicators');
    
    // Safety check
    if (!testimonialsGrid || !prevBtn || !nextBtn || !indicatorsContainer) return;

    // 1. Button Logic: Remove existing listeners by cloning
    const newPrevBtn = prevBtn.cloneNode(true);
    const newNextBtn = nextBtn.cloneNode(true);
    prevBtn.parentNode.replaceChild(newPrevBtn, prevBtn);
    nextBtn.parentNode.replaceChild(newNextBtn, nextBtn);

    const getScrollAmount = () => {
        const card = testimonialsGrid.querySelector('[class^="testimonial-card-"]');
        return (card ? card.offsetWidth : 400) + 32; // Width + gap
    };

    newNextBtn.addEventListener('click', () => {
        testimonialsGrid.scrollBy({ left: getScrollAmount(), behavior: 'smooth' });
    });

    newPrevBtn.addEventListener('click', () => {
        testimonialsGrid.scrollBy({ left: -getScrollAmount(), behavior: 'smooth' });
    });

    // 2. Indicators Logic
    const cards = testimonialsGrid.querySelectorAll('[class^="testimonial-card-"]');
    indicatorsContainer.innerHTML = ''; // Clear any existing dots

    // Create an observer to detect which card is currently visible
    const observerOptions = {
        root: testimonialsGrid,
        threshold: 0.5 // Trigger when 50% of the card is visible
    };

    // Clean up old observer if it exists
    if (testimonialsGrid.testimonialObserver) {
        testimonialsGrid.testimonialObserver.disconnect();
    }

    const observer = new IntersectionObserver((entries) => {
        entries.forEach(entry => {
            if (entry.isIntersecting) {
                // Find which card is visible
                const index = Array.from(cards).indexOf(entry.target);
                
                // Update the active dot
                const dots = indicatorsContainer.querySelectorAll('.carousel-indicator');
                dots.forEach(d => d.classList.remove('active'));
                if (dots[index]) {
                    dots[index].classList.add('active');
                }
            }
        });
    }, observerOptions);
    
    // Save observer reference to the grid element so we can clean it up later
    testimonialsGrid.testimonialObserver = observer;

    // Generate the dots
    cards.forEach((card, index) => {
        const dot = document.createElement('div');
        dot.className = 'carousel-indicator';
        if (index === 0) dot.classList.add('active'); // First one active by default

        // Click event: Scroll to the specific card
        dot.addEventListener('click', () => {
            // 'nearest' prevents the whole page jumping; 'start' aligns card to left
            card.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'start' });
        });

        indicatorsContainer.appendChild(dot);
        observer.observe(card); // Start watching this card for scroll updates
    });
}

function cleanupTestimonialsCarousel() {
    // Clear indicators when switching to mobile
    const indicatorsContainer = document.getElementById('testimonials-indicators');
    if (indicatorsContainer) {
        indicatorsContainer.innerHTML = '';
    }

    // Disconnect the scroll observer
    const testimonialsGrid = document.querySelector('.testimonials-grid');
    if (testimonialsGrid && testimonialsGrid.testimonialObserver) {
        testimonialsGrid.testimonialObserver.disconnect();
        delete testimonialsGrid.testimonialObserver;
    }
}
// --- END: Testimonials Carousel Functions ---


// Animation on scroll and DOM Ready Logic
document.addEventListener('DOMContentLoaded', function() {
    
    // --- START: SIMPLIFIED MENU HIGHLIGHTING LOGIC (Scroll Event) ---
    // NOTE: Updated '#contact-section' to '#contact'
    const sections = document.querySelectorAll(
        '#home, #pricing, #testimonials, #services, #case-studies, #faq, #contact'
    );
    const navLinks = document.querySelectorAll('.main-menu .menu-item');
    const menu = document.querySelector('.main-menu');
    
    function activateLink(id) {
        navLinks.forEach(link => {
            link.classList.remove('active-link');
            if (link.getAttribute('href') === `#${id}`) {
                link.classList.add('active-link');
            }
        });
    }

    function highlightMenuItem() {
        if (window.innerWidth <= 768) return; 

        const scrollPos = window.scrollY;
        const offset = menu.offsetHeight + 200; 
        let activeSectionId = 'home'; 
        let found = false;

        for (let i = sections.length - 1; i >= 0; i--) {
            const section = sections[i];
            const sectionTop = section.offsetTop;
            const sectionId = section.getAttribute('id');

            if (scrollPos >= sectionTop - offset) {
                activeSectionId = sectionId;
                found = true;
                break; 
            }
        }
        
        if (scrollPos < offset && !found) {
             activeSectionId = 'home';
        }
        
        activateLink(activeSectionId);
    }
    
    highlightMenuItem();
    window.addEventListener('scroll', highlightMenuItem);
    window.addEventListener('resize', highlightMenuItem);
    // --- END: SIMPLIFIED MENU HIGHLIGHTING LOGIC ---

    // NOTE: Intersection Observer for "slide-in" animations has been REMOVED per user request.


// Desktop Testimonials Carousel - Initialize on load for desktop (NEW)
    let isTestimonialsCarouselActive = window.innerWidth > 768;
    if (isTestimonialsCarouselActive) {
        initializeTestimonialsCarousel();
    }

// Desktop Service Cards Carousel - Initialize on load for desktop (existing)
    let isServicesCarouselActive = window.innerWidth > 768;
    if (isServicesCarouselActive) {
        initializeServicesCarousel();
    }
    
    // Resize handler to re-initialise/cleanup carousels
    let resizeTimer;
    window.addEventListener('resize', () => {
        clearTimeout(resizeTimer);
        resizeTimer = setTimeout(() => {
            const nowDesktop = window.innerWidth > 768;
            
            // --- Services Carousel Logic (Existing) ---
            if (nowDesktop && !isServicesCarouselActive) {
                initializeServicesCarousel();
                isServicesCarouselActive = true;
            } else if (!nowDesktop && isServicesCarouselActive) {
                cleanupServicesCarousel();
                isServicesCarouselActive = false;
            } else if (nowDesktop && isServicesCarouselActive) {
                const servicesGrid = document.querySelector('.services-grid');
                if (servicesGrid && servicesGrid.updateCarousel) {
                    servicesGrid.updateCarousel();
                }
            }
            
            // --- Testimonials Carousel Logic (NEW) ---
            if (nowDesktop && !isTestimonialsCarouselActive) {
                initializeTestimonialsCarousel();
                isTestimonialsCarouselActive = true;
            } else if (!nowDesktop && isTestimonialsCarouselActive) {
                cleanupTestimonialsCarousel();
                isTestimonialsCarouselActive = false;
            } 
        }, 250);
    });
    // End Carousel Initialization & Resize Handler
    


    // Burger Menu functionality
    const burgerIcon = document.getElementById('burgerIcon');
    const mobileMenuItems = document.getElementById('mobileMenuItems');
    
    if (burgerIcon && mobileMenuItems) {
        burgerIcon.addEventListener('click', (event) => {
            event.stopPropagation(); 
            mobileMenuItems.classList.toggle('active');
        });
        
        mobileMenuItems.querySelectorAll('.menu-item').forEach(item => {
            item.addEventListener('click', () => {
                mobileMenuItems.classList.remove('active');
            });
        });
        
        document.body.addEventListener('click', (event) => {
            if (mobileMenuItems.classList.contains('active') && 
                !mobileMenuItems.contains(event.target) && 
                !burgerIcon.contains(event.target)) {
                mobileMenuItems.classList.remove('active');
            }
        });
    }

    // Custom Slow Scroll
    document.querySelectorAll('a[href^="#"]').forEach(anchor => {
        anchor.addEventListener('click', function (e) {
            e.preventDefault();
            const targetId = this.getAttribute('href');
            const targetElement = document.querySelector(targetId);

            if (targetElement) {
                const menuHeight = document.querySelector('.main-menu').offsetHeight;
                const targetPosition = targetElement.getBoundingClientRect().top + window.pageYOffset - menuHeight;
                const startPosition = window.pageYOffset;
                const distance = targetPosition - startPosition;
                let startTime = null;
                const duration = 1000;

                function animation(currentTime) {
                    if (startTime === null) startTime = currentTime;
                    const timeElapsed = currentTime - startTime;
                    const run = ease(timeElapsed, startPosition, distance, duration);
                    window.scrollTo(0, run);
                    if (timeElapsed < duration) requestAnimationFrame(animation);
                }

                function ease(t, b, c, d) {
                    t /= d / 2;
                    if (t < 1) return c / 2 * t * t + b;
                    t--;
                    return -c / 2 * (t * (t - 2) - 1) + b;
                }

                requestAnimationFrame(animation);
            }
        });
    });

    // --- PRICING CALCULATOR SCRIPT (Dynamic Pricing and Progress Bar) ---
    const slider = document.getElementById('spend-slider');
    const spendValue = document.getElementById('spend-value');
    const managementFee = document.getElementById('management-fee');
    const maxSpendNotification = document.getElementById('max-spend-notification');
    const maxSpendLabel = document.getElementById('max-spend-label');
    // ADD NEW NOTIFICATION ELEMENT
    const minSpendNotification = document.getElementById('min-spend-notification');

    if (slider && spendValue && managementFee && maxSpendNotification && maxSpendLabel && minSpendNotification) {
        
        function formatCurrency(amount) {
            return '£' + Math.round(amount).toLocaleString('en-GB');
        }

        function calculateFees() {
            const spend = parseInt(slider.value);
            const maxSpend = parseInt(slider.getAttribute('max'));
            let calculatedFee = 0; 
            
            const progress = (spend / maxSpend) * 100;
            slider.style.setProperty('--slider-progress', `${progress}%`);
            
            // --- New Tiered Fee Logic ---
            // If spend is 0, fee is 0
            if (spend === 0) {
                calculatedFee = 0;
            } 
            // If spend is between £2,000 and £4,000, fee is £399
            else if (spend >= 2000 && spend <= 4000) { 
                calculatedFee = 399;
            } 
            // If spend is over £4,000 up to £10,000, fee is 10% of spend (min £399 is covered by the £4k tier logic above)
            else if (spend >= 4100 && spend <= 10000) {
                calculatedFee = Math.round(spend * 0.10);
            } 
            // If spend is between £1 and £1,900, fee is £399, but we show the notification
            else if (spend > 0 && spend < 2000) { 
                calculatedFee = 399; 
            }
            // --- End Tiered Fee Logic ---

            managementFee.textContent = formatCurrency(calculatedFee) + 'pm';
            
            let spendText = formatCurrency(spend);
            let maxLabelText = formatCurrency(maxSpend);
            
            // LOGIC FOR MAX SPEND NOTIFICATION (Existing)
            if (spend === maxSpend) {
                spendText += '+pm';
                maxLabelText += '+'; 
                maxSpendNotification.classList.add('show-notification');
            } else {
                spendText += 'pm';
                maxSpendNotification.classList.remove('show-notification');
            }

            // LOGIC FOR MIN SPEND NOTIFICATION (NEW)
            if (spend > 0 && spend < 2000) {
                minSpendNotification.classList.add('show-notification');
            } else {
                minSpendNotification.classList.remove('show-notification');
            }

            spendValue.textContent = spendText;
            maxSpendLabel.textContent = maxLabelText; 
        }

        slider.addEventListener('input', calculateFees);
        calculateFees(); 
    }
    // --- END: PRICING CALCULATOR SCRIPT ---

    
    // --- 2. Mobile Scroll Highlight Logic (Intersection Observer) ---
    if (window.innerWidth <= 768) {
        // --- Service Cards Highlight ---
        const servicesGrid = document.querySelector('.services-grid');
        const mobileServiceCards = document.querySelectorAll('.services-grid > [class^="service-card-"]');
        const mobileCounter = document.getElementById('mobileServiceCounterText'); 
        const totalCards = mobileServiceCards.length;

        if (servicesGrid && mobileServiceCards.length > 0) {
            
            const observerOptions = {
                root: servicesGrid, 
                rootMargin: '0px',
                threshold: 0.75 
            };

            const observerCallback = (entries) => {
                entries.forEach((entry) => { 
                    if (entry.isIntersecting) {
                        mobileServiceCards.forEach(card => {
                            card.classList.remove('in-view');
                        });
                        entry.target.classList.add('in-view');
                        
                        if (mobileCounter) {
                            const cardIndex = Array.from(mobileServiceCards).indexOf(entry.target);
                            mobileCounter.textContent = `${cardIndex + 1} / ${totalCards}`;
                        }
                        
                    } else {
                        entry.target.classList.remove('in-view');
                    }
                });
            };

            const mobileObserver = new IntersectionObserver(observerCallback, observerOptions);

            mobileServiceCards.forEach(card => {
                mobileObserver.observe(card);
            });
        }
        
        // --- Testimonial Cards Highlight (Now uses Intersection Observer for mobile only) ---
        const testimonialsGrid = document.querySelector('.testimonials-grid');
        const mobileTestimonialCards = document.querySelectorAll('.testimonials-grid > [class^="testimonial-card-"]');
        
        if (testimonialsGrid && mobileTestimonialCards.length > 0) {
             const testimonialObserverOptions = {
                root: testimonialsGrid, 
                rootMargin: '0px',
                threshold: 0.75 
            };
            
            // Re-use or create the observer if it doesn't exist (to handle resize)
            if (!window.testimonialMobileObserver) {
                window.testimonialMobileObserver = new IntersectionObserver((entries) => {
                    entries.forEach(entry => {
                        if (entry.isIntersecting) {
                            mobileTestimonialCards.forEach(card => {
                                card.classList.remove('in-view');
                            });
                            entry.target.classList.add('in-view');
                        } else {
                            entry.target.classList.remove('in-view');
                        }
                    });
                }, testimonialObserverOptions);

                mobileTestimonialCards.forEach(card => {
                    window.testimonialMobileObserver.observe(card);
                });
            }
        }
        
        // --- NEW: Case Study Cards Highlight (Mobile Scroller) ---
        const caseStudiesGrid = document.querySelector('.mobile-case-studies-grid');
        const mobileCaseStudyCards = document.querySelectorAll('.mobile-case-studies-grid > [class^="case-study-card-"]');
        const mobileCaseStudyCounter = document.getElementById('mobileCaseStudyCounterText');
        const totalCaseStudyCards = mobileCaseStudyCards.length;
        
        if (caseStudiesGrid && mobileCaseStudyCards.length > 0) {
            
            const caseStudyObserverOptions = {
                root: caseStudiesGrid, 
                rootMargin: '0px',
                threshold: 0.75 
            };

            const caseStudyObserverCallback = (entries) => {
                entries.forEach((entry) => {
                    if (entry.isIntersecting) {
                        mobileCaseStudyCards.forEach(card => {
                            card.classList.remove('in-view');
                        });
                        entry.target.classList.add('in-view');
                        
                        if (mobileCaseStudyCounter) {
                            const cardIndex = Array.from(mobileCaseStudyCards).indexOf(entry.target);
                            mobileCaseStudyCounter.textContent = `${cardIndex + 1} / ${totalCaseStudyCards}`;
                        }
                        
                    } else {
                        entry.target.classList.remove('in-view');
                    }
                });
            };

            const caseStudyMobileObserver = new IntersectionObserver(caseStudyObserverCallback, caseStudyObserverOptions);

            mobileCaseStudyCards.forEach(card => {
                caseStudyMobileObserver.observe(card);
            });
        }
    }
    
    // --- START: CONTACT FORM VALIDATION & SUBMISSION ---
    const contactForm = document.getElementById('contactForm');
    const submitButton = document.getElementById('submit-button');
    const formStatus = document.getElementById('form-status');
    const formSpinner = submitButton ? submitButton.querySelector('.spinner') : null;
    const buttonText = submitButton ? submitButton.querySelector('.button-text') : null;
    
    // Helper function to show/hide error message
    function setInputError(inputElement, isError) {
        const errorDisplay = document.getElementById(inputElement.id + '-error');
        if (isError) {
            inputElement.classList.add('error');
            if (errorDisplay) errorDisplay.classList.add('show');
        } else {
            inputElement.classList.remove('error');
            if (errorDisplay) errorDisplay.classList.remove('show');
        }
    }

    // Main validation function
    function validateForm(form) {
        let isValid = true;
        
        // Fields to validate: name, email, message
        const requiredFields = ['name', 'email', 'message'];
        
        requiredFields.forEach(fieldId => {
            const input = document.getElementById(fieldId);
            if (!input) return;

            const value = input.value.trim();
            let fieldValid = true;

            // 1. Check for required empty fields
            if (value === '') {
                fieldValid = false;
            }
            
            // 2. Check for email format (if it's the email field)
            if (input.id === 'email' && value !== '' && !input.checkValidity()) {
                fieldValid = false;
            }
            
            setInputError(input, !fieldValid);
            if (!fieldValid) {
                isValid = false;
            }
        });
        
        return isValid;
    }

    if (contactForm) {
        
        // Add immediate input handlers to clear errors when user types
        ['name', 'email', 'message'].forEach(fieldId => {
            const input = document.getElementById(fieldId);
            if (input) {
                input.addEventListener('input', () => {
                    const value = input.value.trim();
                    let fieldValid = value !== '';
                    if (input.id === 'email' && value !== '') {
                        fieldValid = input.checkValidity(); 
                    }
                    setInputError(input, !fieldValid);
                });
            }
        });

        contactForm.addEventListener('submit', function(e) {
            e.preventDefault(); 
            formStatus.style.display = 'none'; 
            
            if (!validateForm(this)) {
                const firstError = document.querySelector('.form-group input.error, .form-group textarea.error');
                if (firstError) {
                    firstError.scrollIntoView({ behavior: 'smooth', block: 'center' });
                }
                return;
            }

            // --- Submission Handling (Sending to StaticForms) ---
            
            // Show loading state
            if (formSpinner) formSpinner.style.display = 'inline-block';
            if (buttonText) buttonText.textContent = 'Sending...';
            submitButton.disabled = true;

            const formData = new FormData(contactForm);
            const data = Object.fromEntries(formData.entries());

            fetch(contactForm.action, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Accept': 'application/json'
                },
                body: JSON.stringify(data)
            })
            .then(response => {
                if (response.ok) {
                    const redirectTo = contactForm.querySelector('input[name="redirectTo"]').value;
                    window.location.href = redirectTo;
                } else {
                    return response.json().then(errorData => {
                        throw new Error(errorData.message || 'Form submission failed.');
                    });
                }
            })
            .catch(error => {
                formStatus.className = 'show error';
                formStatus.textContent = 'Error: ' + (error.message || 'There was an issue sending your message. Please try again.');
            })
            .finally(() => {
                if (formSpinner) formSpinner.style.display = 'none';
                if (buttonText) buttonText.textContent = 'Send Message';
                submitButton.disabled = false;
            });
        });
    }
    // --- END: CONTACT FORM VALIDATION & SUBMISSION ---
});
