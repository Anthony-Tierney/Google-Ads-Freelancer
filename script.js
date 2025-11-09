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

// Modal functions
function openModal(modalId) {
    document.getElementById(modalId).style.display = 'block'; 
    document.body.style.overflow = 'hidden';
}

function closeModal(modalId) {
    document.getElementById(modalId).style.display = 'none';
    document.body.style.overflow = 'auto';
}

window.onclick = function(event) {
    // This now handles both general modals and the specific service modal
    if (event.target.classList.contains('modal')) {
        event.target.style.display = 'none';
        document.body.style.overflow = 'auto';
    }
}

// Animation on scroll and DOM Ready Logic
document.addEventListener('DOMContentLoaded', function() {
    const testimonialCards = document.querySelectorAll('.testimonial-card, .testimonial-card-1, .testimonial-card-2, .testimonial-card-3');
    const serviceCards = document.querySelectorAll('[class^="service-card-"]');
    const caseStudyCards = document.querySelectorAll('.case-study-card-1, .case-study-card-2, .case-study-card-3');
    
    const observer = new IntersectionObserver((entries) => {
        entries.forEach((entry) => {
            if (entry.isIntersecting) {
                // Animate testimonials
                if (entry.target.classList.contains('testimonials-section')) {
                    const cards = entry.target.querySelectorAll('.testimonial-card-1, .testimonial-card-2, .testimonial-card-3');
                    // Removed the check for screen size since CSS controls mobile transition
                    cards.forEach((card, index) => {
                        setTimeout(() => {
                            card.classList.add('animate');
                        }, index * 200);
                    });
                }
                // Animate services
                else if (entry.target.classList.contains('services-section')) {
                    // Removed the check for screen size since CSS controls mobile transition
                    const cards = entry.target.querySelectorAll('[class^="service-card-"]');
                    cards.forEach((card) => {
                        card.classList.add('animate');
                    });
                }
                // Animate case studies
                else if (entry.target.classList.contains('case-studies-section')) {
                    const cards = entry.target.querySelectorAll('.case-study-card-1, .case-study-card-2, .case-study-card-3');
                    cards.forEach((card, index) => {
                        setTimeout(() => {
                            card.classList.add('animate');
                        }, index * 200);
                    });
                }
                // Only unobserve sections, individual cards are managed by the mobile observer
                if (entry.target.classList.contains('testimonials-section') || entry.target.classList.contains('services-section') || entry.target.classList.contains('case-studies-section')) {
                    observer.unobserve(entry.target);
                }
            }
        });
    }, { threshold: 0.1 });
    
    const testimonialsSection = document.querySelector('.testimonials-section');
    const servicesSection = document.querySelector('.services-section');
    const caseStudiesSection = document.querySelector('.case-studies-section');
    
    if (testimonialsSection) {
        observer.observe(testimonialsSection);
    }
    if (servicesSection) {
        observer.observe(servicesSection);
    }
    if (caseStudiesSection) {
        observer.observe(caseStudiesSection);
    }

// Desktop Service Cards Carousel - Add to script.js inside DOMContentLoaded


    
// Service Cards Carousel (Desktop Only)
    if (window.innerWidth > 768) {
        const servicesSection = document.querySelector('.services-section');
        const servicesGrid = document.querySelector('.services-grid');
        const serviceCards = document.querySelectorAll('.services-grid > [class^="service-card-"]');
        
        if (servicesSection && servicesGrid && serviceCards.length > 0) {
            
            // 1. Create the NEW main carousel container
            const carouselContainer = document.createElement('div');
            carouselContainer.className = 'carousel-container-wrapper'; // This is our new relative parent

            // --- START: ADDED CODE ---
            // Create and add the counter element
            const counterElement = document.createElement('div');
            counterElement.className = 'service-card-counter';
            carouselContainer.appendChild(counterElement);
            // --- END: ADDED CODE ---

            // 2. Wrap the services grid in its existing wrapper
            const wrapper = document.createElement('div');
            wrapper.className = 'services-grid-wrapper';
            
            // 3. Put the grid wrapper inside the new main container
            carouselContainer.appendChild(wrapper);

            // 4. Put the grid inside its wrapper
            // We MUST insert the new container into the DOM *before* appending the grid
            servicesGrid.parentNode.insertBefore(carouselContainer, servicesGrid);
            wrapper.appendChild(servicesGrid); // Now we move the grid
            
            let currentIndex = 1;
            const cardsPerView = 1;
            const totalSlides = serviceCards.length;
            
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

            // Insert nav container into the *new* main container, before the wrapper
            carouselContainer.insertBefore(navContainer, wrapper);
            
            // Create indicators
            const indicatorsContainer = document.createElement('div');
            indicatorsContainer.className = 'carousel-indicators';
            
            for (let i = 0; i < totalSlides; i++) {
                const indicator = document.createElement('div');
                indicator.className = 'carousel-indicator';
                if (i === 0) indicator.classList.add('active');
                indicator.setAttribute('data-slide', i);
                indicator.setAttribute('aria-label', `Go to slide ${i + 1}`);
                indicatorsContainer.appendChild(indicator);
            }
            
            // Insert indicators *after* the new main container
            carouselContainer.parentNode.insertBefore(indicatorsContainer, carouselContainer.nextSibling);
            
            // Replace the old updateCarousel function with this one
            function updateCarousel() {
                if (serviceCards.length === 0) return;

                // 1. Get dimensions
                const cardWidth = serviceCards[0].offsetWidth;
                const wrapperWidth = wrapper.offsetWidth;
                const gap = 32; // 2rem from your CSS

                // 2. Calculate the total offset to the *start* of the active card
                // This is (width + gap) * index
                const offsetToCard = currentIndex * (cardWidth + gap);

                // 3. Calculate the offset needed to center *a* card
                // This is (wrapper_width / 2) - (card_width / 2)
                const centerOffset = (wrapperWidth / 2) - (cardWidth / 2);

                // 4. The new transform is the centering offset - the offset to the active card
                const newTransform = centerOffset - offsetToCard;

                servicesGrid.style.transform = `translateX(${newTransform}px)`;

                // Update active classes
                serviceCards.forEach((card, index) => {
                    card.classList.toggle('service-card-active', index === currentIndex);
                });

                // Update buttons state
                prevBtn.disabled = currentIndex === 0;
                nextBtn.disabled = currentIndex >= totalSlides - 1; // Use >=
                
                // Update indicators
                document.querySelectorAll('.carousel-indicator').forEach((indicator, index) => {
                    indicator.classList.toggle('active', index === currentIndex);
                });

                // --- START: ADDED CODE ---
                // Update the counter text
                if (counterElement) {
                    counterElement.textContent = `${currentIndex + 1} / ${totalSlides}`;
                }
                // --- END: ADDED CODE ---
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
            
            // Keyboard navigation
            servicesSection.addEventListener('keydown', (e) => {
                if (e.key === 'ArrowLeft' && currentIndex > 0) {
                    currentIndex--;
                    updateCarousel();
                } else if (e.key === 'ArrowRight' && currentIndex < totalSlides - 1) {
                    currentIndex++;
                    updateCarousel();
                }
            });
            
            // Handle window resize
            let resizeTimer;
            window.addEventListener('resize', () => {
                clearTimeout(resizeTimer);
                resizeTimer = setTimeout(() => {
                    if (window.innerWidth > 768) {
                        updateCarousel();
                    }
                }, 250);
            });
            
            // Initial update
            updateCarousel();
        }
    }

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

    // --- PRICING CALCULATOR SCRIPT ---
    const pricingTable = document.getElementById('pricingTable');
    const slider = document.getElementById('spend-slider');
    const spendValue = document.getElementById('spend-value');
    const managementFee = document.getElementById('management-fee');
    const setupFeeRow = document.getElementById('setup-fee-row');
    const setupFee = document.getElementById('setup-fee');
    const accountRadios = document.querySelectorAll('input[name="account"]');
    const googleCreditMessage = document.getElementById('googleCreditMessage');

    // Check if all elements exist before adding listeners
    if (pricingTable && slider && spendValue && managementFee && setupFeeRow && setupFee && accountRadios.length > 0 && googleCreditMessage) {
        
        // State tracking for blur
        let radioAnswered = false;
        let sliderAnswered = false;

        function checkAndUnblur() {
            // This function checks if both conditions are met
            if (radioAnswered && sliderAnswered) {
                pricingTable.classList.remove('blurred');
            }
        }

        // --- Event Listener for Radios ---
        accountRadios.forEach(radio => {
            radio.addEventListener('change', () => {
                radioAnswered = true;
                checkAndUnblur();
                calculateFees();
            });
        });

        // --- Event Listener for Slider ---
        slider.addEventListener('input', (e) => {
            const value = parseInt(e.target.value);

            if (value > 0) {
                // If slider is moved to any value above 0
                if (!sliderAnswered) {
                    sliderAnswered = true;
                }
                checkAndUnblur();
            } else {
                // If slider is moved back to 0
                sliderAnswered = false;
                pricingTable.classList.add('blurred');
            }

            // This part runs every time the slider moves
            spendValue.textContent = formatCurrency(value) + 'pm';
            calculateFees();
        });

        function formatCurrency(amount) {
            return '£' + amount.toLocaleString('en-GB');
        }

        function calculateFees() {
            const spend = parseInt(slider.value);
            
            // Check which radio is selected.
            const checkedRadio = document.querySelector('input[name="account"]:checked');
            const hasAccount = checkedRadio ? checkedRadio.value === 'yes' : false;
            const isNo = checkedRadio ? checkedRadio.value === 'no' : false;
            const isOver4k = spend >= 4000;

            // Calculate management fee
            let fee = 399;
            if (spend > 4000) {
                const increments = Math.floor((spend - 4000) / 500);
                fee = 399 + (increments * 50);
            }

            // Cap the fee at 3500
            if (fee > 3500) {
                fee = 3500;
            }
            
            managementFee.textContent = formatCurrency(fee) + 'pm';
            
            // Logic for setup fee row AND Google Credit Message
            if (hasAccount) {
                // 'Yes' is selected
                setupFeeRow.style.display = 'none'; // Hide setup fee row
                googleCreditMessage.style.display = 'none'; // Hide credit message
            } else if (isNo) {
                // 'No' is selected
                googleCreditMessage.style.display = 'flex'; // Show credit message
                
                if (isOver4k) {
                    // 'No' AND '>= £4k'
                    setupFeeRow.style.display = 'none'; // Hide setup row
                } else {
                    // 'No' AND '< £4k'
                    setupFeeRow.style.display = ''; // Show setup fee row
                    setupFee.textContent = '£99';
                }
            } else { 
                // No radio selected yet (Initial state)
                setupFeeRow.style.display = ''; // Show setup fee row
                setupFee.textContent = '£99';   // Set default text
                googleCreditMessage.style.display = 'none'; // Hide credit message
            }
        }

        // Initial call to set fees based on default (slider=0, radio=unchecked)
        calculateFees(); 
        
        // Set initial slider text to include 'pm'
        spendValue.textContent = formatCurrency(parseInt(slider.value)) + 'pm';
    }
    // --- END: PRICING CALCULATOR SCRIPT ---

    
    // --- 2. Mobile Scroll Highlight Logic (Intersection Observer) ---
    
    // Check if we are on a mobile-sized screen
    if (window.innerWidth <= 768) {
        // --- Service Cards Highlight ---
        const servicesGrid = document.querySelector('.services-grid');
        const mobileServiceCards = document.querySelectorAll('.services-grid > [class^="service-card-"]');

        if (servicesGrid && mobileServiceCards.length > 0) {
            
            const observerOptions = {
                root: servicesGrid, // The scrolling container
                rootMargin: '0px',
                threshold: 0.75 // 75% of the card must be visible
            };

            const observerCallback = (entries) => {
                entries.forEach(entry => {
                    if (entry.isIntersecting) {
                        // First, remove .in-view from all cards
                        mobileServiceCards.forEach(card => {
                            card.classList.remove('in-view');
                        });
                        // Then, add .in-view to the one that just came into view
                        entry.target.classList.add('in-view');
                    } else {
                        // This handles removing the class when it scrolls out
                        entry.target.classList.remove('in-view');
                    }
                });
            };

            const mobileObserver = new IntersectionObserver(observerCallback, observerOptions);

            mobileServiceCards.forEach(card => {
                mobileObserver.observe(card);
            });
        }
        
        // --- Testimonial Cards Highlight ---
        const testimonialsGrid = document.querySelector('.testimonials-grid');
        const mobileTestimonialCards = document.querySelectorAll('.testimonials-grid > [class^="testimonial-card-"]');
        
        if (testimonialsGrid && mobileTestimonialCards.length > 0) {
             const testimonialObserverOptions = {
                root: testimonialsGrid, // The scrolling container
                rootMargin: '0px',
                threshold: 0.75 // 75% of the card must be visible
            };

            const testimonialObserverCallback = (entries) => {
                entries.forEach(entry => {
                    if (entry.isIntersecting) {
                        // First, remove .in-view from all cards
                        mobileTestimonialCards.forEach(card => {
                            card.classList.remove('in-view');
                        });
                        // Then, add .in-view to the one that just came into view
                        entry.target.classList.add('in-view');
                    } else {
                        // This handles removing the class when it scrolls out
                        entry.target.classList.remove('in-view');
                    }
                });
            };
            
            const testimonialMobileObserver = new IntersectionObserver(testimonialObserverCallback, testimonialObserverOptions);

            mobileTestimonialCards.forEach(card => {
                testimonialMobileObserver.observe(card);
            });
        }
    }
});
